/**
 * DiscoveryService.ts
 *
 * PhotoTrans 局域网设备发现。
 *
 * 机制（near 模式）：
 *  - 使用 @ohos.net.socket 的 UDP socket 周期发送 PT-BEACON 报文到子网广播地址，
 *    负载内含本机 deviceId/名称/端口/协议版本/品牌。
 *  - 同时绑定本机端口接收他机 beacon，形成可连接的设备列表。
 *  - 每个设备在实际文件传输时仍需在 TCP 上完成 PT-HI 握手（NetworkService 负责）。
 */

import { socket } from '@kit.NetworkKit';
import hilog from '@ohos.hilog';
import { util } from '@kit.ArkTS';
import {
  Brand,
  Constants,
  DiscoveredDevice
} from '../models/DataModels';

const LOG_DOMAIN = 0x5048;
const LOG_TAG = 'DiscoveryService';

/** 设备发现回调 */
export type DiscoveryListener = (devices: DiscoveredDevice[]) => void;

const BEACON_PREFIX = 'PT-BEACON';

/** beacon 字符串 -> DiscoveredDevice */
function parseBeacon(line: string, fromIp: string): DiscoveredDevice | null {
  const parts = line.split('|');
  if (parts.length < 6 || parts[0] !== BEACON_PREFIX) {
    return null;
  }
  // PT-BEACON|<deviceId>|<name>|<port>|<proto>|<brand>
  let brand: Brand = Brand.UNKNOWN;
  try { brand = parts[5] as Brand; } catch (e) { /* keep */ }
  return {
    deviceId: parts[1],
    deviceName: parts[2],
    brand: brand,
    ip: fromIp,
    port: Number.parseInt(parts[3]) || Constants.DEFAULT_TRANSFER_PORT,
    protocolVersion: parts[4],
    lastSeen: Date.now(),
    isSelf: false,
    signal: 0
  };
}

function encodeUtf8(s: string): ArrayBuffer {
  return new util.TextEncoder().encodeInto(s);
}

function decodeUtf8(buf: ArrayBuffer): string {
  return new util.TextDecoder().decodeToString(new Uint8Array(buf));
}

/**
 * DiscoveryService - 单例。
 */
export class DiscoveryService {
  private static instance: DiscoveryService | null = null;

  private myDeviceId: string = '';
  private myName: string = '';
  private myBrand: Brand = Brand.HUAWEI;

  private udpSocket: socket.UDPSocket | null = null;
  private running: boolean = false;
  private beaconTimer: number = -1;
  private pruneTimer: number = -1;
  private devices: Map<string, DiscoveredDevice> = new Map();
  private listener: DiscoveryListener | null = null;
  private readonly pruneMs: number = 8000;

  private selfIp: string = '';

  private constructor() {
  }

  static getInstance(): DiscoveryService {
    if (DiscoveryService.instance === null) {
      DiscoveryService.instance = new DiscoveryService();
    }
    return DiscoveryService.instance;
  }

  setupIdentity(deviceId: string, name: string, brand: Brand): void {
    this.myDeviceId = deviceId;
    this.myName = name;
    this.myBrand = brand;
  }

  setListener(l: DiscoveryListener | null): void { this.listener = l; }

  getSelfIp(): string { return this.selfIp; }

  getDevices(): DiscoveredDevice[] {
    const out: DiscoveredDevice[] = [];
    this.devices.forEach(v => out.push(v));
    return out;
  }

  /**
   * 启动发现流程，周期性广播 beacon。
   * @param transferPort 本机 TCP 服务器端口，写入 beacon
   */
  async startDiscovery(transferPort: number): Promise<void> {
    if (this.running) { return; }
    this.running = true;

    // 初始化基础身份
    if (this.myDeviceId.length === 0) {
      this.myDeviceId = `PH-${Date.now().toString(36)}`;
    }

    const udp = socket.constructUDPSocketInstance();
    this.udpSocket = udp;

    udp.on('message', (info: socket.SocketMessageInfo) => {
      const text = decodeUtf8(info.message);
      const fromIp = String(info.remoteInfo.address ?? '');
      const dev = parseBeacon(text, fromIp);
      if (dev && dev.deviceId !== this.myDeviceId) {
        dev.lastSeen = Date.now();
        this.devices.set(dev.deviceId, dev);
        if (this.listener) {
          this.listener(this.getDevices());
        }
      }
    });

    udp.on('error', (err) => {
      hilog.error(LOG_DOMAIN, LOG_TAG, `udp error ${JSON.stringify(err)}`);
    });

    // 绑定接收端口（任一可用的）。
    try {
      await udp.bind({ address: '0.0.0.0', family: 1, port: Constants.DISCOVERY_PORT });
    } catch (e) {
      hilog.warn(LOG_DOMAIN, LOG_TAG, `bind ${Constants.DISCOVERY_PORT} fail, bind 0`);
      await udp.bind({ address: '0.0.0.0', family: 1, port: 0 });
    }

    // 周期广播
    const broadcast = () => {
      if (!this.running || !this.udpSocket) { return; }
      const beacon = `${BEACON_PREFIX}|${this.myDeviceId}|${this.myName}|${transferPort}|1.0|${this.myBrand}`;
      const payload = encodeUtf8(beacon);
      const targets = [this.broadcastAddress(this.selfIp), '255.255.255.255'];
      for (const addr of targets) {
        try {
          this.udpSocket.send({
            data: payload,
            address: addr,
            port: Constants.DISCOVERY_PORT
          });
        } catch (e) {
          hilog.warn(LOG_DOMAIN, LOG_TAG, `broadcast to ${addr} fail: ${JSON.stringify(e)}`);
        }
      }
    };

    broadcast();
    this.beaconTimer = setInterval(broadcast, 2000);

    // 设备过期清理
    const prune = () => {
      if (!this.running) { return; }
      const now = Date.now();
      let changed = false;
      this.devices.forEach((dev, id) => {
        if (now - dev.lastSeen > this.pruneMs) {
          this.devices.delete(id);
          changed = true;
        }
      });
      if (changed && this.listener) {
        this.listener(this.getDevices());
      }
    };
    this.pruneTimer = setInterval(prune, 2000);
  }

  /** 计算子网广播地址（近似第三字节 +1）。失败回退 255.255.255.255 */
  private broadcastAddress(ip: string): string {
    if (ip.length === 0 || ip === '0.0.0.0') {
      return '255.255.255.255';
    }
    const parts = ip.split('.');
    if (parts.length !== 4) { return '255.255.255.255'; }
    const third = Number.parseInt(parts[2]) || 0;
    parts[2] = String((third + 1) % 256);
    parts[3] = '255';
    return parts.join('.');
  }

  /** 记录本机 IP（由上层填充，通常是 WiFi/以太网地址） */
  setLocalIp(ip: string): void {
    this.selfIp = ip;
  }

  /** 停止发现流程 */
  stopDiscovery(): void {
    this.running = false;
    if (this.beaconTimer >= 0) {
      clearInterval(this.beaconTimer);
      this.beaconTimer = -1;
    }
    if (this.pruneTimer >= 0) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = -1;
    }
    if (this.udpSocket) {
      try { this.udpSocket.close(); } catch (e) { /* ignore */ }
      this.udpSocket = null;
    }
  }
}

export default DiscoveryService;