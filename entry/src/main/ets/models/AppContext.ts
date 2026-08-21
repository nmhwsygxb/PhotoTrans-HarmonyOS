/**
 * AppContext.ts
 *
 * PhotoTrans 全局共享上下文（轻量全局单例）。
 * 页面通过 getAppContext() 获取跨页面的服务实例与 WindowStage。
 *
 * 注意：ArkTS 严格模式不允许模块级可变导出，这里统一经由单一实例暴露。
 */

import { window } from '@kit.ArkUI';

/**
 * Application 级共享对象。
 */
export class AppContext {
  private static win: window.WindowStage | null = null;

  /** 由 EntryAbility 在 loadContent 成功回调里注入 */
  static setWindowStage(ws: window.WindowStage): void {
    AppContext.win = ws;
  }

  static getWindowStage(): window.WindowStage | null {
    return AppContext.win;
  }

  /** 获取当前窗口实例（可空） */
  static getMainWindow(): window.Window | null {
    if (AppContext.win === null) {
      return null;
    }
    return null; // 无缓存，调用方按需取
  }
}

/** 供页面调用的全局 accessor */
export function useGlobal(): AppContext {
  return AppContext;
}

/** 仅用于让页面拿到 WindowStage（可为 null） */
export function getWindowStage(): window.WindowStage | null {
  return AppContext.getWindowStage();
}