/**
 * FormatDetector.ts
 *
 * PhotoTrans 照片格式检测与品牌识别。
 *
 * 通过读取文件头魔数 (magic bytes) 与扩展名，识别来自不同厂商（华为、OPPO、
 * vivo、小米、三星、苹果）的照片格式，包括：
 *  - 静态图片：JPEG / PNG / WEBP / HEIC / GIF / BMP / DNG / RAW
 *  - 动态照片：在图片所在目录查找伴随的 .mov / .mp4 / .hdr 文件
 *  - HDR：HEIF/Apple HDR、厂商 HDR 扩展
 *
 * 检测到未知格式时返回 UNKNOWN，并引导调用方触发「模型学习」。
 */

import fileIo from '@ohos.file.fs';
import hilog from '@ohos.hilog';
import image from '@ohos.multimedia.image';
import {
  Brand,
  PhotoFormatFeature
} from '../models/DataModels';

const LOG_DOMAIN = 0x5048;
const LOG_TAG = 'FormatDetector';

/** 支持的照片格式目录（内置启发式规则） */
const FORMAT_FEATURES: PhotoFormatFeature[] = [
  { format: 'JPEG', brand: Brand.UNKNOWN, magicPrefix: 'ffd8ff', supportsDynamic: true, isHDR: false, extension: '.jpg' },
  { format: 'JPEG-HDR', brand: Brand.UNKNOWN, magicPrefix: 'ffd8ff', supportsDynamic: true, isHDR: true, extension: '.jpg' },
  { format: 'PNG', brand: Brand.UNKNOWN, magicPrefix: '89504e470d0a1a0a', supportsDynamic: false, isHDR: false, extension: '.png' },
  { format: 'WEBP', brand: Brand.UNKNOWN, magicPrefix: '52494646', supportsDynamic: false, isHDR: false, extension: '.webp' },
  { format: 'HEIC', brand: Brand.HUAWEI, magicPrefix: '', supportsDynamic: true, isHDR: true, extension: '.heic' },
  { format: 'HEIF', brand: Brand.APPLE, magicPrefix: '', supportsDynamic: true, isHDR: true, extension: '.heif' },
  { format: 'RAW-DNG', brand: Brand.UNKNOWN, magicPrefix: '', supportsDynamic: false, isHDR: true, extension: '.dng' },
  { format: 'GIF', brand: Brand.UNKNOWN, magicPrefix: '47494638', supportsDynamic: false, isHDR: false, extension: '.gif' },
  { format: 'BMP', brand: Brand.UNKNOWN, magicPrefix: '424d', supportsDynamic: false, isHDR: false, extension: '.bmp' },
  { format: 'SAMSUNG-RAW', brand: Brand.SAMSUNG, magicPrefix: '', supportsDynamic: false, isHDR: true, extension: '.srw' },
];

/**
 * 检测结果。
 */
export interface DetectionResult {
  feature: PhotoFormatFeature | null;
  brand: Brand;
  mime: string;
  width: number;
  height: number;
  /** 是否为动态照片 */
  isDynamic: boolean;
  /** 动态照片伴随视频路径（相对或绝对） */
  companionVideoPath: string;
  /** 是否 HDR */
  isHDR: boolean;
  /** 是否未知（需要模型学习） */
  needsLearning: boolean;
}

/** @ohos.file.fs 打开文件后读取前若干字节（带头魔术判断） */
function readMagic(path: string, maxBytes: number = 16): ArrayBuffer {
  try {
    const f = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY);
    const buf = new ArrayBuffer(maxBytes);
    const read = fileIo.readSync(f.fd, buf);
    fileIo.closeSync(f);
    if (read > 0) {
      return buf.slice(0, read);
    }
    return new ArrayBuffer(0);
  } catch (e) {
    return new ArrayBuffer(0);
  }
}

function toHex(arr: Uint8Array, upTo: number): string {
  let s = '';
  const n = Math.min(arr.length, upTo);
  for (let i = 0; i < n; i++) {
    s += arr[i].toString(16).padStart(2, '0');
  }
  return s;
}

function matchMagic(magicHex: string, prefix: string): boolean {
  if (!prefix) { return false; }
  if (magicHex.length < prefix.length) { return false; }
  return magicHex.startsWith(prefix);
}

/** 根据文件名推断扩展名（小写） */
export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) { return ''; }
  return name.substring(dot).toLowerCase();
}

/**
 * FormatDetector - 单例。
 */
export class FormatDetector {
  private static instance: FormatDetector | null = null;

  /**（模型学习后）扩充的规则表 */
  private learnedFeatures: PhotoFormatFeature[] = [];

  private constructor() {
  }

  static getInstance(): FormatDetector {
    if (FormatDetector.instance === null) {
      FormatDetector.instance = new FormatDetector();
    }
    return FormatDetector.instance;
  }

  /** 注入/替换学习到的特征（来自 ModelStore） */
  setLearnedFeatures(features: PhotoFormatFeature[]): void {
    this.learnedFeatures = features;
  }

  getLearnedFeatures(): PhotoFormatFeature[] {
    return this.learnedFeatures.slice();
  }

  /**
   * 检测单一图片文件。
   * @param path 绝对路径
   * @param fileName 可选显示名（否则从 path 派生）
   */
  async detect(path: string, fileName?: string): Promise<DetectionResult> {
    const name = fileName ?? path.substring(path.lastIndexOf('/') + 1);
    const ext = extOf(name);
    const magicBuf = readMagic(path, 16);
    const magicHex = toHex(new Uint8Array(magicBuf), 16);

    let feature: PhotoFormatFeature | null = null;
    // 1) 精确按扩展名匹配内置规则
    for (const f of FORMAT_FEATURES) {
      if (f.extension === ext) {
        feature = f;
        break;
      }
    }
    // 2) 进一步用魔数校正
    if (feature) {
      if (feature.magicPrefix && !matchMagic(magicHex, feature.magicPrefix)) {
        // 魔数不符，保留特征但标记可疑；暂无强校验。
      }
    } else {
      // 3) 无扩展名匹配 → 用魔数匹配
      for (const f of FORMAT_FEATURES) {
        if (f.magicPrefix && matchMagic(magicHex, f.magicPrefix)) {
          feature = f;
          break;
        }
      }
    }
    // 4) 模型学习到的规则
    if (!feature) {
      for (const f of this.learnedFeatures) {
        if (f.extension === ext || (f.magicPrefix && matchMagic(magicHex, f.magicPrefix))) {
          feature = f;
          break;
        }
      }
    }

    // 解析尺寸
    const size = await this.readDimensions(path);

    // 判断 HDR
    const isHDR = feature ? feature.isHDR : false;

    // 判断动态照片：查找伴随视频
    const base = path.substring(0, path.lastIndexOf('.'));
    const isDynamic = this.lookForDynamicCompanion(base);
    let companionPath = '';
    if (isDynamic) {
      companionPath = this.findCompanionPath(base);
    }

    const needsLearning = feature === null;
    // 品牌推断：优先特征，其次扩展名
    let brand = feature ? feature.brand : Brand.UNKNOWN;
    if (brand === Brand.UNKNOWN) {
      brand = this.brandByExt(ext);
    }

    const mime = this.mimeFor(ext);

    return {
      feature,
      brand,
      mime,
      width: size.width,
      height: size.height,
      isDynamic,
      companionVideoPath: companionPath,
      isHDR,
      needsLearning
    };
  }

  /** 基于扩展名推断品牌（启发式） */
  private brandByExt(ext: string): Brand {
    switch (ext) {
      case '.heic': return Brand.HUAWEI;
      case '.heif': return Brand.APPLE;
      case '.hevc':
      case '.h265': return Brand.HUAWEI;
      case '.srw':
      case '.dng': return ext === '.srw' ? Brand.SAMSUNG : Brand.XIAOMI;
      case '.avif': return Brand.XIAOMI;
      case '.jpg':
      case '.jpeg': return Brand.UNKNOWN;
      default: return Brand.UNKNOWN;
    }
  }

  private mimeFor(ext: string): string {
    switch (ext) {
      case '.jpg': case '.jpeg': return 'image/jpeg';
      case '.png': return 'image/png';
      case '.webp': return 'image/webp';
      case '.gif': return 'image/gif';
      case '.bmp': return 'image/bmp';
      case '.heic': return 'image/heic';
      case '.heif': return 'image/heif';
      case '.webm': return 'video/webm';
      default: return 'application/octet-stream';
    }
  }

  /** 尝试用 image 能力解析宽高 */
  private readDimensions(path: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve) => {
      image.createImageSource(path).then((source) => {
        return source.getImageInfo().then((info) => {
          source.release();
          resolve({ width: info.size.width, height: info.size.height });
        });
      }).catch(() => {
        resolve({ width: 0, height: 0 });
      });
    });
  }

  /**
   * 判断是否为动态照片：在同一基础名目录下存在匹配的 .mov/.mp4/.hdr 文件。
   * @param base path 去掉扩展名的绝对路径
   */
  private lookForDynamicCompanion(base: string): boolean {
    const candidates = ['.mov', '.mp4', '.hdr', '.HDR', '.MOV', '.MP4'];
    for (const c of candidates) {
      try {
        fileIo.accessSync(base + c);
        return true;
      } catch (e) { /* not found */ }
    }
    return false;
  }

  private findCompanionPath(base: string): string {
    const candidates = ['.mov', '.MOV', '.mp4', '.MP4', '.hdr', '.HDR'];
    for (const c of candidates) {
      try {
        fileIo.accessSync(base + c);
        return base + c;
      } catch (e) { /* continue */ }
    }
    return '';
  }

  /**
   * 通过 @ohos.file.fs 列出目录中所有媒体的简单探测（用于「全选照片」）。
   * 返回可访问的照片文件绝对路径列表（过滤常见视频/图片扩展名）。
   */
  listMediaIn(dir: string): string[] {
    const out: string[] = [];
    try {
      const files = fileIo.listFileSync(dir);
      const photoExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif', '.dng', '.avif'];
      for (const f of files) {
        const ext = extOf(f);
        if (photoExts.includes(ext)) {
          out.push(`${dir}/${f}`);
        }
      }
    } catch (e) {
      hilog.warn(LOG_DOMAIN, LOG_TAG, `listMediaIn fail ${dir}: ${JSON.stringify(e)}`);
    }
    return out;
  }

  /** 返回所有可支持的格式清单（内置+学习） */
  supportedFormats(): string[] {
    const s = new Set<string>();
    FORMAT_FEATURES.forEach(f => s.add(f.format));
    this.learnedFeatures.forEach(f => s.add(f.format));
    return Array.from(s);
  }
}

export default FormatDetector;