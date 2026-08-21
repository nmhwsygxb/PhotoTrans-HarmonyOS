/**
 * EntryAbility.ts
 *
 * PhotoTrans 应用入口。
 * 负责创建窗口、初始化全局服务（NetworkService / DiscoveryService /
 * ModelStore / FormatDetector）、生成稳定的设备身份并在 First onWindowStageCreate
 * 阶段启动 TCP 服务器。
 */

import { AbilityConstant, UIAbility, Want, Context } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import hilog from '@ohos.hilog';
import { BusinessError } from '@kit.BasicServicesKit';
import { preferences } from '@kit.ArkData';
import deviceInfo from '@ohos.deviceInfo';
import {
  Brand,
  Constants
} from '../models/DataModels';
import NetworkService from '../services/NetworkService';
import DiscoveryService from '../services/DiscoveryService';
import FormatDetector from '../services/FormatDetector';
import ModelStore from '../services/ModelStore';
import { AppContext } from '../models/AppContext';

const LOG_DOMAIN = 0x5048;
const LOG_TAG = 'EntryAbility';

/** 生成稳定的设备 ID（优先取持久化的，否则生成并保存） */
async function resolveDeviceId(context: Context): Promise<string> {
  const pref = await preferences.getPreferences(context, 'phototrans_identity');
  let id = pref.getSync('device_id', '') as string;
  if (id.length === 0) {
    const brandHint = Brand.HUAWEI;
    id = `PH-${brandHint}-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`;
    await pref.put('device_id', id);
    await pref.flush();
  }
  return id;
}

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(LOG_DOMAIN, LOG_TAG, 'Ability onCreate');
  }

  onDestroy(): void {
    hilog.info(LOG_DOMAIN, LOG_TAG, 'Ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    hilog.info(LOG_DOMAIN, LOG_TAG, 'Ability onWindowStageCreate');

    // 初始化全局服务
    const ns = NetworkService.getInstance();
    const ds = DiscoveryService.getInstance();
    const ms = ModelStore.getInstance();
    const fd = FormatDetector.getInstance();

    const context = this.context;

    resolveDeviceId(context).then((deviceId) => {
      const deviceName = this.buildDeviceName();
      ns.setupIdentity(deviceId, deviceName, Brand.HUAWEI);
      // 接收目录使用应用缓存下
      ns.setReceiveDir(context.filesDir);
      ds.setupIdentity(deviceId, deviceName, Brand.HUAWEI);
      ModelStore.getInstance().init(context).then(() => {
        // 将学习到的特征注入 FormatDetector
        try {
          fd.setLearnedFeatures(ms.getFeatures());
        } catch (e) {
          hilog.warn(LOG_DOMAIN, LOG_TAG, `inject features fail ${JSON.stringify(e)}`);
        }
      });

      // 启动 TCP 服务器（接收端）
      ns.startServer(Constants.DEFAULT_TRANSFER_PORT).catch((e) => {
        hilog.error(LOG_DOMAIN, LOG_TAG, `startServer fail ${JSON.stringify(e)}`);
      });
    });

    windowStage.loadContent('pages/Index', (err, data) => {
      if (err.code) {
        hilog.error(LOG_DOMAIN, LOG_TAG, 'Failed to load content: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(LOG_DOMAIN, LOG_TAG, 'Loaded Index page');

      // 记录 windowStage（供全屏/转场使用）
      AppContext.setWindowStage(windowStage);
    });
  }

  private buildDeviceName(): string {
    try {
      const model = deviceInfo.marketName ?? '';
      if (model.length > 0) {
        return `华为${model}`;
      }
    } catch (e) { /* ignore */ }
    return 'PhotoTrans';
  }

  onWindowStageDestroy(): void {
    hilog.info(LOG_DOMAIN, LOG_TAG, 'Ability onWindowStageDestroy');
    // 停止发现与监听
    DiscoveryService.getInstance().stopDiscovery();
  }

  onForeground(): void {
    hilog.info(LOG_DOMAIN, LOG_TAG, 'Ability onForeground');
  }

  onBackground(): void {
    hilog.info(LOG_DOMAIN, LOG_TAG, 'Ability onBackground');
  }
}