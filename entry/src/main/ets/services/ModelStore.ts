/**
 * ModelStore.ts
 *
 * PhotoTrans 模型版本管理与存储。
 *
 * 「模型学习」负责识别不同品牌产商照片的新格式。模型元数据（版本、安装时间、
 * 品牌覆盖、校验和等）通过 @ohos.data.preferences 持久化；学习到的格式特征
 * 通过 @ohos.file.fs 序列化为 JSON 存放到应用沙箱文件。
 */

import preferences from '@ohos.data.preferences';
import fileIo from '@ohos.file.fs';
import hilog from '@ohos.hilog';
import { Context } from '@kit.AbilityKit';
import {
  Brand,
  ModelVersion,
  PhotoFormatFeature,
  RemoteModelInfo
} from '../models/DataModels';

const LOG_DOMAIN = 0x5048;
const LOG_TAG = 'ModelStore';

const PREF_NAME = 'phototrans_models';
const KEY_CURRENT_MODEL = 'current_model';
const KEY_CONFIGURED = 'models_configured';
const FEATURES_FILE = 'learned.formats.json';

/**
 * ModelStore - 单例。
 */
export class ModelStore {
  private static instance: ModelStore | null = null;

  private pref: preferences.Preferences | null = null;
  private modelDir: string = '/data';
  private learnedFeatures: PhotoFormatFeature[] = [];
  private currentVersion: ModelVersion | null = null;

  private constructor() {
  }

  static getInstance(): ModelStore {
    if (ModelStore.instance === null) {
      ModelStore.instance = new ModelStore();
    }
    return ModelStore.instance;
  }

  /**
   * 在 Ability 生命周期中初始化（传入上下文）。
   */
  async init(context: Context): Promise<void> {
    this.pref = await preferences.getPreferences(context, PREF_NAME);
    // 沙箱 files 目录
    try {
      this.modelDir = context.filesDir;
    } catch (e) {
      this.modelDir = '/data';
    }
    // 读取当前模型
    const ver = this.pref.getSync(KEY_CURRENT_MODEL, '') as string;
    if (ver) {
      try {
        this.currentVersion = JSON.parse(ver) as ModelVersion;
      } catch (e) {
        this.currentVersion = null;
      }
    }
    this.loadFeatures();
  }

  /** 加载学习到的格式特征 */
  private loadFeatures(): void {
    const path = `${this.modelDir}/${FEATURES_FILE}`;
    try {
      const text = fileIo.readTextSync(path);
      this.learnedFeatures = JSON.parse(text) as PhotoFormatFeature[];
    } catch (e) {
      this.learnedFeatures = [];
    }
  }

  private persistFeatures(): void {
    const path = `${this.modelDir}/${FEATURES_FILE}`;
    try {
      fileIo.writeTextSync(path, JSON.stringify(this.learnedFeatures));
    } catch (e) {
      hilog.error(LOG_DOMAIN, LOG_TAG, `persistFeatures fail ${JSON.stringify(e)}`);
    }
  }

  /**
   * 记录一次「模型学习」：把检测出的新格式特征加入学习表。
   */
  async learnFeature(feature: PhotoFormatFeature): Promise<boolean> {
    // 去重：相同 format+extension 不再重复
    for (const f of this.learnedFeatures) {
      if (f.format === feature.format && f.extension === feature.extension) {
        return false;
      }
    }
    this.learnedFeatures.push(feature);
    this.persistFeatures();
    // 提升模型版本
    await this.bumpVersion();
    return true;
  }

  async removeFeature(format: string, ext: string): Promise<void> {
    this.learnedFeatures = this.learnedFeatures.filter(f => !(f.format === format && f.extension === ext));
    this.persistFeatures();
  }

  getFeatures(): PhotoFormatFeature[] {
    return this.learnedFeatures.slice();
  }

  private async bumpVersion(): Promise<void> {
    if (!this.pref) { return; }
    const nowVer = this.currentVersion ? this.currentVersion.version : 1;
    const mv: ModelVersion = {
      version: nowVer + 1,
      installedAt: Date.now(),
      brands: [Brand.UNKNOWN],
      sizeBytes: 1024,
      changelog: '本地学习新增格式',
      source: 'local',
      status: 'installed',
      md5: ''
    };
    this.currentVersion = mv;
    await this.pref.put(KEY_CURRENT_MODEL, JSON.stringify(mv));
    await this.pref.put(KEY_CONFIGURED, true);
    await this.pref.flush();
    hilog.info(LOG_DOMAIN, LOG_TAG, `model bumped to v${mv.version}`);
  }

  /** 安装远程模型（需预先下载；此处保存元数据并写入特征文件） */
  async installRemote(info: RemoteModelInfo, features: PhotoFormatFeature[]): Promise<void> {
    if (!this.pref) { return; }
    const mv: ModelVersion = {
      version: info.version,
      installedAt: Date.now(),
      brands: info.brands,
      sizeBytes: info.sizeBytes,
      changelog: info.changelog,
      source: info.url,
      status: 'installed',
      md5: info.md5
    };
    this.currentVersion = mv;
    this.learnedFeatures = features;
    this.persistFeatures();
    await this.pref.put(KEY_CURRENT_MODEL, JSON.stringify(mv));
    await this.pref.put(KEY_CONFIGURED, true);
    await this.pref.flush();
  }

  getCurrentVersion(): ModelVersion | null {
    return this.currentVersion;
  }

  /** 可达的远程模型列表（预置） */
  listRemote(): RemoteModelInfo[] {
    return [
      {
        version: 11,
        sizeBytes: 220000,
        changelog: '接入华为/OPPO/小米动态照片与 HDR 识别',
        publishDate: '2024-06-01',
        brands: [Brand.HUAWEI, Brand.OPPO, Brand.XIAOMI],
        url: 'https://models.phototrans.app/v11.json',
        md5: ''
      },
      {
        version: 12,
        sizeBytes: 380000,
        changelog: '新增三星/苹果/一加格式与 RAW 支持',
        publishDate: '2024-09-15',
        brands: [Brand.SAMSUNG, Brand.APPLE, Brand.ONE_PLUS],
        url: 'https://models.phototrans.app/v12.json',
        md5: ''
      }
    ];
  }

  /** 重置（删除学习特征） */
  async reset(): Promise<void> {
    this.learnedFeatures = [];
    this.persistFeatures();
    this.currentVersion = null;
    if (this.pref) {
      await this.pref.delete(KEY_CURRENT_MODEL);
      await this.pref.flush();
    }
  }
}

export default ModelStore;