/**
 * NetworkService.ts
 *
 * PhotoTrans 核心网络层：基于 @ohos.net.socket 的 TCP 客户端与服务器。
 *
 * 职责：
 *  - 启动 TCP 服务器接收连接（近场 / 远场共用同一个监听端口）
 *  - 作为客户端发起连接并完成 PT-HI 握手
 *  - 实现与 Android 版本一致的 HTTP PUT 风格文件传输协议
 *  - 批量文件队列、逐文件进度、实时速度 / ETA / 百分比计算与回调
 *
 * 传输协议（字节流，与 Android 版本一致）：
 *  握手：
 *    S->R:  PT-HI <deviceName>\n
 *    R->S:  PT-HI <deviceName>\n
 *  文件（HTTP PUT 风格，与 Android 版本一致）：
 *    S->R:  PUT /<filename> HTTP/1.1\r\nContent-Length: <size>\r\n\r\n
 *    S->R:  <原始字节流>
 *    R->S:  HTTP/1.1 200 OK\r\n\r\n
 */

import { socket } from '@kit.NetworkKit';
import fileIo from '@ohos.file.fs';
import hilog from '@ohos.hilog';
import { util } from '@kit.ArkTS';
import {
  Brand,
  Constants,
  PendingFile,
  FileProgress,
  TransferDirection,
  TransferState,
  TransferTaskProgress,
  ProtocolPacket
} from '../models/DataModels';

const LOG_DOMAIN = 0x5048; // "PH"
const LOG_TAG = 'NetworkService';

/** 传输更新回调 */
export type ProgressCallback = (progress: TransferTaskProgress) => void;
/** 单个文件完成回调 */
export type FileDoneCallback = (fileId: string, ok: boolean) => void;

/** UTF-8 字符串 -> ArrayBuffer */
function encodeUtf8(s: string): ArrayBuffer {
  const enc = new util.TextEncoder();
  return enc.encodeInto(s);
}

/** ArrayBuffer -> UTF-8 字符串 */
function decodeUtf8(buffer: ArrayBuffer): string {
  const dec = new util.TextDecoder();
  return dec.decodeToString(new Uint8Array(buffer));
}

/** 拼接字节缓冲（避免把二进制文件体误按 UTF-8 解码） */
function concatBytes(a: Uint8Array | null, b: Uint8Array): Uint8Array {
  if (a === null || a.length === 0) {
    return b;
  }
  if (b.length === 0) {
    return a;
  }
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** UTF-8 字符串的字节长度 */
function utf8Length(s: string): number {
  return encodeUtf8(s).byteLength;
}

// ---------------------------------------------------------------------------
// 接收方向的内部上下文
// ---------------------------------------------------------------------------
interface RxPeer {
  conn: socket.TCPSocketConnection;
  peerName: string;
  /** 字节级累积缓冲（握手 / HTTP 请求头） */
  byteAcc: Uint8Array | null;
  /** 已进入 HTTP 请求头累积（等待 \r\n\r\n） */
  pendingHeader: string;
  /** 当前在接收文件体 */
  inBody: boolean;
  /** 当前文件剩余字节 */
  bodyRemaining: number;
  /** 当前文件输出流 */
  outStream: fileIo.File | null;
  /** 当前文件元信息 */
  currentMeta: RxFileMeta | null;
}

interface RxFileMeta {
  fileId: string;
  fileName: string;
  size: number;
  kind: string;   // 'photo' | 'video' | 'file' | 'dynamic'
  brand: string;
}

/** 速度 / ETA 计算器 */
class SpeedMeter {
  private bytes: number = 0;
  private samples: number[] = [];
  private lastTs: number = 0;

  reset(): void {
    this.bytes = 0;
    this.samples = [];
    this.lastTs = 0;
  }

  /** 增量喂入已传输字节，返回平滑后的 MB/s */
  feed(addedBytes: number): number {
    this.bytes += addedBytes;
    const now = Date.now();
    if (this.lastTs === 0) {
      this.lastTs = now;
      return 0;
    }
    const dtSec = (now - this.lastTs) / 1000;
    this.lastTs = now;
    if (dtSec <= 0.01) {
      return this.current();
    }
    const inst = addedBytes / dtSec / (1024 * 1024);
    this.samples.push(inst);
    if (this.samples.length > Constants.SPEED_SAMPLES) {
      this.samples.shift();
    }
    return this.current();
  }

  current(): number {
    if (this.samples.length === 0) {
      return 0;
    }
    let sum = 0;
    for (const s of this.samples) {
      sum += s;
    }
    return sum / this.samples.length;
  }

  /** 由峰值速度与总字节估算 ETA（秒） */
  static eta(remainingBytes: number, speedMBps: number): number {
    if (speedMBps <= 0) {
      return 0;
    }
    return remainingBytes / (speedMBps * 1024 * 1024);
  }
}

/**
 * NetworkService - 单例网络服务。
 */
export class NetworkService {
  private static instance: NetworkService | null = null;

  private myDeviceName: string = 'PhotoTrans';
  private myBrand: Brand = Brand.HUAWEI;
  private myDeviceId: string = '';

  // 服务器
  private serverSocket: socket.TCPSocketServer | null = null;
  private serverPort: number = Constants.DEFAULT_TRANSFER_PORT;
  private rxPeers: RxPeer[] = [];

  // 客户端连接
  private clientSocket: socket.TCPSocket | null = null;
  private clientConnection: socket.TCPSocketConnection | null = null;
  private clientTextBuf: string = '';
  private clientInBody: boolean = false;

  // 发送队列
  private fileQueue: PendingFile[] = [];
  private isSending: boolean = false;
  private activeTx: TxContext | null = null;

  // 回调
  private progressHandler: ProgressCallback | null = null;
  private fileDoneHandler: FileDoneCallback | null = null;

  /** 接收保存根目录（fs 路径） */
  private receiveDir: string = '';

  private constructor() {
  }

  static getInstance(): NetworkService {
    if (NetworkService.instance === null) {
      NetworkService.instance = new NetworkService();
    }
    return NetworkService.instance;
  }

  setupIdentity(deviceId: string, deviceName: string, brand: Brand): void {
    this.myDeviceId = deviceId;
    this.myDeviceName = deviceName;
    this.myBrand = brand;
    hilog.info(LOG_DOMAIN, LOG_TAG, `identity id=${deviceId} name=${deviceName}`);
  }

  /** 设置接收文件保存目录 */
  setReceiveDir(dir: string): void {
    this.receiveDir = dir;
  }

  setProgressHandler(h: ProgressCallback | null): void { this.progressHandler = h; }
  setFileDoneHandler(h: FileDoneCallback | null): void { this.fileDoneHandler = h; }

  getListeningPort(): number { return this.serverPort; }

  // ===========================================================================
  // 工具
  // ===========================================================================
  private logBuf(tag: string, msg: string): void {
    hilog.info(LOG_DOMAIN, LOG_TAG, `${tag} ${msg}`);
  }
  private logErr(tag: string, msg: string): void {
    hilog.error(LOG_DOMAIN, LOG_TAG, `${tag} ${msg}`);
  }

  /** 向连接写一行 ASCII/UTF-8 文本（自动补 \n） */
  private writeLine(connLike: socket.TCPSocketConnection, line: string): void {
    try {
      connLike.send({
        data: encodeUtf8(line + '\n')
      });
    } catch (e) {
      this.logErr('writeLine', `${JSON.stringify(e)}`);
    }
  }

  /** 任务进度字典 */
  private tasks: Map<string, TransferTaskProgress> = new Map();

  private makeFileProgress(f: PendingFile, transferred: number): FileProgress {
    return {
      fileId: f.fileId,
      fileName: f.fileName,
      totalBytes: f.size,
      transferredBytes: transferred,
      percent: f.size > 0 ? Math.min(100, Math.round(transferred / f.size * 100)) : 0,
      speedMBps: 0,
      etaSeconds: 0,
      startAt: Date.now(),
      isPhoto: f.isPhoto
    };
  }

  // ===========================================================================
  // 服务器端（接收）
  // ===========================================================================

  async startServer(port: number = Constants.DEFAULT_TRANSFER_PORT): Promise<void> {
    if (this.serverSocket) {
      this.logBuf('startServer', 'already running');
      return;
    }
    const server = socket.constructTCPSocketServer();
    this.serverSocket = server;
    this.serverPort = port;

    server.on('connect', (conn: socket.TCPSocketConnection) => {
      this.logBuf('connect', `incoming ${conn.remoteAddress.address}:${conn.remoteAddress.port}`);
      const peer: RxPeer = {
        conn: conn,
        peerName: 'unknown',
        byteAcc: null,
        pendingHeader: '',
        inBody: false,
        bodyRemaining: 0,
        outStream: null,
        currentMeta: null
      };
      this.rxPeers.push(peer);
      conn.on('message', (buffer: ArrayBuffer) => this.onRxData(peer, buffer));
      conn.on('close', () => this.onRxClose(peer));
    });

    server.on('error', (err) => {
      this.logErr('server.error', JSON.stringify(err));
    });

    try {
      await server.listen({
        address: '0.0.0.0',
        port: port
      } as socket.TCPServerExtraOptions);
      this.logBuf('startServer', `listening ${port}`);
    } catch (e) {
      this.logErr('startServer', `listen fail ${JSON.stringify(e)}`);
      this.serverSocket = null;
      throw e;
    }
  }

  private onRxClose(peer: RxPeer): void {
    this.logBuf('rxClose', peer.peerName);
    if (peer.outStream) {
      try { peer.outStream.closeSync(); } catch (e) { /* ignore */ }
      peer.outStream = null;
    }
    const idx = this.rxPeers.indexOf(peer);
    if (idx >= 0) { this.rxPeers.splice(idx, 1); }
  }

  private onRxData(peer: RxPeer, buffer: ArrayBuffer): void {
    if (peer.inBody) {
      this.consumeBody(peer, new Uint8Array(buffer));
      return;
    }
    // 字节级累积（避免把二进制文件体误按 UTF-8 解码）
    peer.byteAcc = concatBytes(peer.byteAcc, new Uint8Array(buffer));
    let guard = 0;
    while (peer.byteAcc !== null && peer.byteAcc.length > 0 && guard++ < 64) {
      const acc = peer.byteAcc;
      const s = decodeUtf8(acc.buffer.slice(acc.byteOffset, acc.byteOffset + acc.length));
      if (peer.pendingHeader !== '') {
        // 收集 HTTP 请求头，直到 \r\n\r\n 空行
        const idx = s.indexOf('\r\n\r\n');
        if (idx < 0) {
          return; // 头部尚未完整，等待更多数据
        }
        const mid = s.substring(0, idx);
        const fullHeader = peer.pendingHeader + mid;
        peer.pendingHeader = '';
        const consumed = utf8Length(fullHeader + '\r\n\r\n');
        peer.byteAcc = (consumed >= acc.length) ? null : acc.slice(consumed);
        this.beginPut(peer, fullHeader);
        if (peer.inBody && peer.byteAcc !== null && peer.byteAcc.length > 0) {
          const rest = peer.byteAcc;
          peer.byteAcc = null;
          this.consumeBody(peer, rest);
        }
        return;
      }
      // 行模式（PT-HI 握手 / PUT 起始行）
      const nl = s.indexOf('\n');
      if (nl < 0) {
        return; // 等待完整一行
      }
      const line = s.substring(0, nl).trim();
      peer.byteAcc = (nl + 1 >= acc.length) ? null : acc.slice(nl + 1);
      if (line.startsWith('PT-HI')) {
        const peerName = ProtocolPacket.parse(line);
        if (peerName) {
          peer.peerName = peerName;
          this.writeLine(peer.conn, ProtocolPacket.ack(this.myDeviceName));
        }
        continue;
      }
      if (line.startsWith('PUT ')) {
        peer.pendingHeader = line + '\r\n';
        continue;
      }
      this.logBuf('rxIgnore', line);
    }
  }

  /** 解析 PUT 行并创建接收文件（标准 HTTP PUT 格式，与 Android 兼容） */
  private beginPut(peer: RxPeer, line: string): void {
    // PUT /<filename> HTTP/1.1\r\nContent-Length: <n>\r\n\r\n
    // line 是累积的，包含多个 \r\n 行
    const lines = line.split('\r\n');
    const requestLine = lines[0];
    if (!requestLine.startsWith('PUT /')) {
      this.writeLine(peer.conn, 'HTTP/1.1 400 Bad Request\r\n');
      return;
    }
    // 提取文件名
    const pathMatch = requestLine.match(/^PUT\s+\/([^\s]+)\s+HTTP/);
    const rawPath = pathMatch ? pathMatch[1] : 'file.bin';
    let fileName = 'file.bin';
    try { fileName = decodeURIComponent(rawPath); } catch (e) { fileName = rawPath; }

    // 解析 Content-Length
    let size = 0;
    for (const l of lines) {
      const lower = l.toLowerCase();
      if (lower.startsWith('content-length:')) {
        const val = l.split(':')[1]?.trim() || '0';
        size = Number.parseInt(val) || 0;
      }
    }

    if (size <= 0) {
      this.writeLine(peer.conn, 'HTTP/1.1 411 Length Required\r\n');
      return;
    }

    // 构造接收路径
    const dest = this.buildReceivePath(fileName);
    if (dest.length === 0) {
      this.writeLine(peer.conn, 'HTTP/1.1 507 Insufficient Storage\r\n');
      return;
    }

    peer.inBody = true;
    peer.bodyRemaining = size;
    peer.currentMeta = {
      fileId: `rx-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      fileName: fileName,
      size: size,
      kind: this.inferKind(fileName),
      brand: 'unknown'
    };
    try {
      peer.outStream = fileIo.openSync(dest, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    } catch (e) {
      this.logErr('beginPut', `open fail ${dest} ${JSON.stringify(e)}`);
      this.writeLine(peer.conn, 'HTTP/1.1 500 Internal Error\r\n');
      peer.inBody = false;
      peer.outStream = null;
      return;
    }
    // 202 接受
    this.writeLine(peer.conn, 'HTTP/1.1 202 Accepted\r\n');
  }

  /** 构造安全接收路径（放在 receiveDir/<kind>/）。返回空串表示失败 */
  private buildReceivePath(fileName: string): string {
    const safe = fileName.replace(/[\\/:*?"<>|]/g, '_');
    const sub = this.receiveDir.length > 0 ? this.receiveDir : '/data/inbox';
    const realDir = `${sub}/PhotoTrans`;
    try {
      fileIo.mkdirSync(realDir, true);
    } catch (e) { /* ignore exists */ }
    const dest = `${realDir}/${safe}`;
    try { fileIo.accessSync(dest); } catch (e) {
      // doesn't exist -> ok
    }
    return dest;
  }

  /** 根据文件名推断类别（图片/视频/普通文件） */
  private inferKind(fileName: string): string {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') ||
      lower.endsWith('.gif') || lower.endsWith('.webp') || lower.endsWith('.heic') ||
      lower.endsWith('.heif') || lower.endsWith('.bmp') || lower.endsWith('.dng') ||
      lower.endsWith('.raw')) {
      return 'photo';
    }
    if (lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.3gp') ||
      lower.endsWith('.mkv') || lower.endsWith('.webm')) {
      return 'video';
    }
    return 'file';
  }

  private consumeBody(peer: RxPeer, buffer: Uint8Array): void {
    const meta = peer.currentMeta;
    if (!meta || !peer.outStream) { return; }
    let take = buffer.length;
    if (peer.bodyRemaining < buffer.length) {
      take = peer.bodyRemaining;
    }
    if (take > 0) {
      try {
        const chunkOut = buffer.slice(0, take);
        fileIo.writeSync(peer.outStream.fd,
          chunkOut.buffer.slice(chunkOut.byteOffset, chunkOut.byteOffset + chunkOut.length));
      } catch (e) {
        this.logErr('consumeBody', `write fail ${JSON.stringify(e)}`);
        peer.inBody = false;
        return;
      }
      peer.bodyRemaining -= take;
      // 剩余未消费的字节（如果超出）继续处理
      if (take < buffer.length) {
        const extra = buffer.slice(take);
        // 理论上 body 之后还有下一个 PUT；把多余字节作为文本/帧。
        peer.inBody = false;
        peer.byteAcc = null;
        // 已有 outStream 完成
        this.finalizeRx(peer, true);
        this.onRxData(peer, extra.buffer.slice(extra.byteOffset, extra.byteOffset + extra.length));
        return;
      }
    }
    if (peer.bodyRemaining <= 0) {
      peer.inBody = false;
      this.finalizeRx(peer, false);
    }
  }

  private finalizeRx(peer: RxPeer, keepOpen: boolean): void {
    const meta = peer.currentMeta;
    if (peer.outStream) {
      try { peer.outStream.closeSync(); } catch (e) { /* ignore */ }
      peer.outStream = null;
    }
    if (meta) {
      // 标准 HTTP 200 OK 响应（与 Android 兼容）
      this.writeLine(peer.conn, 'HTTP/1.1 200 OK\r\n');
      this.logBuf('finalizeRx', `received ${meta.fileName}`);
      if (this.fileDoneHandler) {
        this.fileDoneHandler(meta.fileId, true);
      }
    }
    peer.currentMeta = null;
    peer.bodyRemaining = 0;
  }

  // ===========================================================================
  // 客户端端（发送）
  // ===========================================================================

  /**
   * 连接到远端并发送一批文件。
   * @param ip 目标 IP
   * @param port 目标端口
   * @param files 待发送文件
   * @param peerName 展示用
   */
  async connectAndSend(ip: string, port: number, files: PendingFile[], peerName: string): Promise<void> {
    if (this.isSending) {
      throw new Error('already busy sending');
    }
    // 建立连接 + 握手
    await this.openClient(ip, port, peerName);
    this.fileQueue = files.slice();
    this.isSending = true;
    const taskId = `tx-${Date.now()}`;
    const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
    const task = this.newTask(taskId, TransferDirection.SEND, peerName, files, totalBytes);
    task.state = TransferState.HANDSHAKE;
    this.tasks.set(taskId, task);
    this.activeTx = { taskId, task, meter: new SpeedMeter(), index: 0 };
    this.drainQueue();
  }

  private drainQueue(): void {
    const tx = this.activeTx;
    if (!tx) { return; }
    if (tx.index >= this.fileQueue.length) {
      // 全部完成
      tx.task.state = TransferState.COMPLETED;
      tx.task.overallPercent = 100;
      this.emit(tx.task);
      this.cleanupTx();
      return;
    }
    const f = this.fileQueue[tx.index];
    const fileProg: FileProgress = this.makeFileProgress(f, 0);
    tx.task.currentFile = fileProg;
    tx.task.transferredBytes = this.fileQueue.slice(0, tx.index).reduce((a, x) => a + x.size, 0);
    this.emit(tx.task);
    this.sendOneFile(tx, f).then(() => {
      tx.index++;
      tx.task.completedFiles++;
      tx.task.currentFile = null;
      tx.task.overallPercent = tx.task.totalBytes > 0 ?
        Math.round(tx.task.transferredBytes / tx.task.totalBytes * 100) : 100;
      this.emit(tx.task);
      this.drainQueue();
    }).catch((err) => {
      tx.task.state = TransferState.FAILED;
      tx.task.errorMessage = `${err}`;
      this.emit(tx.task);
      this.cleanupTx();
    });
  }

  private cleanupTx(): void {
    this.activeTx = null;
    this.isSending = false;
    this.fileQueue = [];
    if (this.clientSocket) {
      this.clientSocket.close();
      this.clientSocket = null;
    }
    this.clientConnection = null;
  }

  /** 发送单个文件（标准 HTTP PUT 格式，与 Android 兼容） */
  private async sendOneFile(tx: TxContext, f: PendingFile): Promise<void> {
    tx.meter.reset();
    return new Promise<void>((resolve, reject) => {
      const conn = this.clientConnection;
      if (!conn) { reject(new Error('no connection')); return; }
      const encodedName = encodeURIComponent(f.fileName);
      const header = `PUT /${encodedName} HTTP/1.1\r\nContent-Length: ${f.size}\r\n\r\n`;
      conn.send({ data: encodeUtf8(header) });

      let inStream: fileIo.File | null = null;
      try {
        inStream = fileIo.openSync(f.path, fileIo.OpenMode.READ_ONLY);
      } catch (e) {
        reject(new Error(`cannot open ${f.path}: ${JSON.stringify(e)}`));
        return;
      }
      const stat = fileIo.statSync(f.path);
      const total = stat.size;
      let sent = 0;
      const bufSize = Constants.SEND_BUFFER;
      const buf = new ArrayBuffer(bufSize);
      const u8 = new Uint8Array(buf);
      let completed = false;

      const lastProgress = { ts: 0 };

      // 校验 202 响应是否有必要：为简化，Android 版也等待；这里写文件体前发 202 由接收方回复，
      // 但流式发送不必等待，直接发送 body。收方对多余 ACK 吸收。
      // 这里仍然读取对方可能发回的 202 帧（本实现已在客户端 attachClient 处理）。

      const pump = () => {
        if (completed) { return; }
        let read: number;
        try {
          read = fileIo.readSync(inStream!.fd, buf);
        } catch (e) {
          completed = true;
          try { inStream!.closeSync(); } catch (e2) { /* ignore */ }
          reject(new Error(`read fail: ${JSON.stringify(e)}`));
          return;
        }
        if (read <= 0) {
          completed = true;
          try { inStream!.closeSync(); } catch (e2) { /* ignore */ }
          resolve();
          return;
        }
        const chunk = buf.slice(0, read);
        conn.send({
          data: chunk
        }, (err) => {
          if (err) {
            completed = true;
            try { inStream!.closeSync(); } catch (e2) { /* ignore */ }
            reject(new Error(`send fail: ${err.code}`));
            return;
          }
          sent += read;
          const now = Date.now();
          const speed = tx.meter.feed(read);
          if (now - lastProgress.ts >= Constants.PROGRESS_THROTTLE_MS || sent >= total) {
            lastProgress.ts = now;
            // 更新任务
            tx.task.transferredBytes = this.fileQueue.slice(0, tx.index).reduce((a, x) => a + x.size, 0) + sent;
            const fp = tx.task.currentFile;
            if (fp) {
              fp.transferredBytes = sent;
              fp.speedMBps = speed;
              fp.percent = total > 0 ? Math.min(100, Math.round(sent / total * 100)) : 0;
              fp.etaSeconds = SpeedMeter.eta(total - sent, speed);
            }
            if (speed > tx.task.peakSpeedMBps) { tx.task.peakSpeedMBps = speed; }
            tx.task.overallPercent = tx.task.totalBytes > 0 ?
              Math.round(tx.task.transferredBytes / tx.task.totalBytes * 100) : 0;
            this.emit(tx.task);
          }
          pump();
        });
      };
      pump();
    });
  }

  // ---------------------------------------------------------------------------
  // 客户端连接建立 + 握手
  // ---------------------------------------------------------------------------
  private openClient(ip: string, port: number, peerName: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tcp = socket.constructTCPSocketInstance();
      this.clientSocket = tcp;
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          try { tcp.close(); } catch (e) { /* ignore */ }
          reject(new Error('connect timeout'));
        }
      }, Constants.CONNECT_TIMEOUT_MS);

      // 握手：连接成功后发 HELLO 并等待 ACK
      tcp.on('connect', () => {
        this.logBuf('client.connect', `connected ${ip}:${port}`);
        // 发送 HELLO（Android 兼容格式）
        try {
          tcp.send({
            data: encodeUtf8(ProtocolPacket.hello(this.myDeviceName) + '\n')
          });
        } catch (e) {
          clearTimeout(timer);
          if (!resolved) { resolved = true; reject(e); }
          return;
        }
        this.clientTextBuf = '';
        // 等待 ACK
        let ackRecv = false;
        tcp.on('message', (buffer: ArrayBuffer) => {
          this.clientTextBuf += decodeUtf8(buffer);
          let nl = this.clientTextBuf.indexOf('\n');
          while (nl >= 0 && !ackRecv) {
            const line = this.clientTextBuf.substring(0, nl).trim();
            this.clientTextBuf = this.clientTextBuf.substring(nl + 1);
            if (line.startsWith('PT-HI')) {
              const peerName = ProtocolPacket.parse(line);
              if (peerName) {
                ackRecv = true;
                clearTimeout(timer);
                if (!resolved) {
                  resolved = true;
                  resolve();
                }
              }
              break;
            }
            nl = this.clientTextBuf.indexOf('\n');
          }
        });
      });

      tcp.on('error', (err) => {
        this.logErr('client.error', JSON.stringify(err));
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          try { tcp.close(); } catch (e) { /* ignore */ }
          reject(new Error(`connect error: ${JSON.stringify(err)}`));
        }
      });

      try {
        tcp.connect({
          address: ip,
          port: port,
          timeout: Constants.CONNECT_TIMEOUT_MS
        } as socket.TCPConnectOptions);
      } catch (e) {
        clearTimeout(timer);
        if (!resolved) { resolved = true; reject(e); }
      }
    });
  }

  // ===========================================================================
  // 任务状态 / 进度
  // ===========================================================================
  private newTask(taskId: string, direction: TransferDirection, peerName: string,
    files: PendingFile[], totalBytes: number): TransferTaskProgress {
    return {
      taskId, state: TransferState.CONNECTING, direction, peerName,
      totalFiles: files.length, completedFiles: 0, currentFile: null,
      totalBytes, transferredBytes: 0, overallPercent: 0,
      peakSpeedMBps: 0, startTime: Date.now(), errorMessage: ''
    };
  }

  private emit(task: TransferTaskProgress): void {
    if (this.progressHandler) {
      this.progressHandler(task);
    }
  }

  /** 查询任务列表（远端传输完成后的快照） */
  getActiveTasks(): TransferTaskProgress[] {
    const out: TransferTaskProgress[] = [];
    this.tasks.forEach(v => out.push(v));
    return out;
  }

  /** 释放某个任务 */
  clearTask(taskId: string): void {
    this.tasks.delete(taskId);
  }

  stopAll(): void {
    if (this.clientSocket) {
      try { this.clientSocket.close(); } catch (e) { /* ignore */ }
      this.clientSocket = null;
    }
    this.isSending = false;
    this.activeTx = null;
  }
}

/** 发送任务上下文 */
interface TxContext {
  taskId: string;
  task: TransferTaskProgress;
  meter: SpeedMeter;
  index: number;
}

// 循环 import 安全：util.TextEncoder/TextDecoder 直接引用全局，无循环依赖。
export default NetworkService;