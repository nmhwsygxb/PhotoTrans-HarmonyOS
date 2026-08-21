/**
 * DataModels.ts
 *
 * PhotoTrans - 跨品牌文件/照片传输
 * 全局类型定义。所有服务与页面共用的接口、枚举、常量都在此处定义。
 */

// ---------------------------------------------------------------------------
// 设备 / 连接
// ---------------------------------------------------------------------------

/**
 * 连接模式。
 * NEAR：局域网自动发现（multicast/广播 + PT-HI 握手）
 * FAR ：基于 IP 的 TCP 直连（扫码或手动输入 IP）
 */
export enum ConnectMode {
  NEAR = 'near',
  FAR = 'far'
}

/**
 * 识别到的手机品牌。
 */
export enum Brand {
  UNKNOWN = 'unknown',
  HUAWEI = 'huawei',
  OPPO = 'oppo',
  VIVO = 'vivo',
  XIAOMI = 'xiaomi',
  SAMSUNG = 'samsung',
  APPLE = 'apple',
  HONOR = 'honor',
  ONE_PLUS = 'oneplus',
  OTHER = 'other'
}

/**
 * 局域网中发现的可连接设备。
 */
export interface DiscoveredDevice {
  /** 设备唯一标识（由 PT-HI 握手获得） */
  deviceId: string;
  /** 设备显示的昵称 */
  deviceName: string;
  /** 品牌 */
  brand: Brand;
  /** 局域网 IP */
  ip: string;
  /** 远距离连接监听端口 */
  port: number;
  /** 握手协议版本 */
  protocolVersion: string;
  /** 最近一次看到该设备的时间戳 (ms) */
  lastSeen: number;
  /** 是否为当前设备自己 */
  isSelf: boolean;
  /** 信号强度或距离估计 (0-100) */
  signal: number;
}

// ---------------------------------------------------------------------------
// 传输
// ---------------------------------------------------------------------------

/**
 * 传输方向。
 */
export enum TransferDirection {
  SEND = 'send',
  RECEIVE = 'receive'
}

/**
 * 传输状态机。
 */
export enum TransferState {
  IDLE = 'idle',
  CONNECTING = 'connecting',
  HANDSHAKE = 'handshake',
  TRANSFERRING = 'transferring',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled'
}

/**
 * 单一文件传输进度。
 */
export interface FileProgress {
  /** 文件标识 */
  fileId: string;
  /** 文件名 */
  fileName: string;
  /** 文件大小（字节） */
  totalBytes: number;
  /** 已传输字节 */
  transferredBytes: number;
  /** 百分比 0-100 */
  percent: number;
  /** 实时速度 MB/s */
  speedMBps: number;
  /** 剩余时间（秒） */
  etaSeconds: number;
  /** 起始时间戳 ms */
  startAt: number;
  /** 是否为照片（含动态照片/HDR） */
  isPhoto: boolean;
}

/**
 * 整体传输任务进度（多个文件批量）。
 */
export interface TransferTaskProgress {
  taskId: string;
  state: TransferState;
  direction: TransferDirection;
  peerName: string;
  totalFiles: number;
  completedFiles: number;
  currentFile: FileProgress | null;
  /** 累计字节 */
  totalBytes: number;
  /** 累计已传输字节 */
  transferredBytes: number;
  /** 整体百分比 */
  overallPercent: number;
  /** 峰值速度 MB/s */
  peakSpeedMBps: number;
  /** 开始时间戳 */
  startTime: number;
  /** 失败原因 */
  errorMessage: string;
}

/**
 * 待传输文件条目（发送方准备队列）。
 */
export interface PendingFile {
  fileId: string;
  /** 显示名称 */
  fileName: string;
  /** 绝对路径（fs 可读） */
  path: string;
  /** 大小 */
  size: number;
  /** 是否照片 */
  isPhoto: boolean;
  /** 动态照片伴随视频路径（存在时） */
  companionVideoPath: string;
  /** 品牌来源 */
  brandHint: Brand;
}

// ---------------------------------------------------------------------------
// 照片格式 / 模型学习
// ---------------------------------------------------------------------------

/**
 * 可辨识的照片格式特征。
 */
export interface PhotoFormatFeature {
  format: string;
  brand: Brand;
  /** 文件头魔数（十六进制字节前缀），用于非 HEIC 等格式启发式判断 */
  magicPrefix?: string;
  /** 支持动态照片（伴随 HDR/深度/视频数据） */
  supportsDynamic: boolean;
  /** 是否 HDR */
  isHDR: boolean;
  /** 扩展名列表 */
  extension: string;
}

/**
 * 模型版本元信息。
 */
export interface ModelVersion {
  /** 自增版本号 */
  version: number;
  /** 下载/安装时间戳 ms */
  installedAt: number;
  /** 数据集覆盖的品牌 */
  brands: Brand[];
  /** 模型大小 byte */
  sizeBytes: number;
  /** 更新日志 */
  changelog: string;
  /** 服务器地址（可在设置中配置源） */
  source: string;
  /** 状态 */
  status: 'installed' | 'downloading' | 'pending';
  /** MD5 校验 */
  md5: string;
}

/**
 * 模型仓库可用的远程版本描述。
 */
export interface RemoteModelInfo {
  version: number;
  sizeBytes: number;
  changelog: string;
  publishDate: string;
  brands: Brand[];
  url: string;
  md5: string;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 全局常量。
 */
export class Constants {
  /** 应用协议魔数（与 Android 版本一致） */
  static readonly HANDSHAKE_MAGIC: string = 'PT-HI';
  /** 远距离传输默认监听端口（与 Android 版本一致：47808） */
  static readonly DEFAULT_TRANSFER_PORT: number = 47808;
  /** 发现服务端口 */
  static readonly DISCOVERY_PORT: number = 47809;
  /** 最大分包大小（配合 socket 写入） */
  static readonly SEND_BUFFER: number = 8192;
  /** 进度回调节流间隔 ms */
  static readonly PROGRESS_THROTTLE_MS: number = 250;
  /** 速度与大文件阈值（>500MB 显示详细速度/ETA） */
  static readonly LARGE_FILE_THRESHOLD: number = 500 * 1024 * 1024;
  /** 记录速度历史窗口（用于平滑） */
  static readonly SPEED_SAMPLES: number = 8;
  /** 断开超时 ms */
  static readonly CONNECT_TIMEOUT_MS: number = 8000;
  /** 是否展示实时速度的阈值 */
  static readonly SHOW_SPEED_THRESHOLD: number = 16 * 1024 * 1024;
  /** 局域网广播组地址 */
  static readonly MULTICAST_ADDR: string = '239.255.80.80';
}

/**
 * PT-HI 握手协议报文结构。
 *
 * 与 Android / iOS 版本兼容的简单文本协议：
 *  S->R:  PT-HI <deviceName>\n
 *  R->S:  PT-HI <deviceName>\n
 *
 * 文件传输层（HTTP PUT 风格，与 Android 版本一致）：
 *  S->R:  PUT /<fileName> HTTP/1.1\r\nContent-Length: <size>\r\n\r\n
 *  S->R:  原始文件字节流
 *  R->S:  HTTP/1.1 200 OK\r\n\r\n
 */
export class ProtocolPacket {
  /** 拼接握手包（Android 兼容格式） */
  static hello(deviceName: string): string {
    return `${Constants.HANDSHAKE_MAGIC} ${deviceName}`;
  }

  static ack(deviceName: string): string {
    return `${Constants.HANDSHAKE_MAGIC} ${deviceName}`;
  }

  /** 解析握手响应，返回设备名或空 */
  static parse(line: string): string | null {
    if (!line.startsWith(Constants.HANDSHAKE_MAGIC)) {
      return null;
    }
    const name = line.substring(Constants.HANDSHAKE_MAGIC.length).trim();
    return name.length > 0 ? name : null;
  }
}

/**
 * 应用事件常量（用于 UI 与服务的松耦合通信）。
 */
export class AppEvents {
  static readonly DEVICE_FOUND: string = 'pt:device_found';
  static readonly DEVICE_LOST: string = 'pt:device_lost';
  static readonly TRANSFER_UPDATE: string = 'pt:transfer_update';
  static readonly TRANSFER_DONE: string = 'pt:transfer_done';
  static readonly MODEL_UPDATED: string = 'pt:model_updated';
}