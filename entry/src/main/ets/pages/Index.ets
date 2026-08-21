/**
 * Index.ets
 *
 * PhotoTrans 主页：承载连接模式切换（near / far）、入口卡片，
 * 以及全局接收进度栏的容器。
 */

import router from '@ohos.router';
import {
  TransferState,
  TransferTaskProgress
} from '../models/DataModels';
import NetworkService from '../services/NetworkService';
import ModelStore from '../services/ModelStore';

@Entry
@Component
struct Index {
  @State nearActive: boolean = true;
  @State receivingStatus: string = '';
  @State currentProgress: TransferTaskProgress | null = null;
  @State showProgressCard: boolean = false;
  @State modelLabel: string = '模型 v-';

  private ns: NetworkService = NetworkService.getInstance();

  aboutToAppear(): void {
    const ver = ModelStore.getInstance().getCurrentVersion();
    this.modelLabel = ver ? `模型 v${ver.version}` : '模型 v-';
    this.ns.setProgressHandler((p) => {
      this.currentProgress = p;
      this.receivingStatus = this.describe(p);
      this.showProgressCard = true;
    });
  }

  private describe(p: TransferTaskProgress): string {
    switch (p.state) {
      case TransferState.TRANSFERRING:
        return `${p.direction === 'send' ? '发送' : '接收'}中 ${p.completedFiles}/${p.totalFiles} 个文件`;
      case TransferState.COMPLETED:
        return `完成 ${p.totalFiles} 个文件`;
      case TransferState.FAILED:
        return `失败：${p.errorMessage}`;
      case TransferState.CONNECTING:
        return '正在连接...';
      default:
        return p.state;
    }
  }

  @Builder
  private ModeSwitch() {
    Row() {
      Text('近场发现').fontSize(16)
        .fontColor(this.nearActive ? '#FFFFFF' : '#333333')
        .padding({ top: 10, bottom: 10 })
        .layoutWeight(1)
        .textAlign(TextAlign.Center)
        .backgroundColor(this.nearActive ? '#0A59F7' : '#00000000')
        .borderRadius(18)
        .onClick(() => { this.nearActive = true; })
      Text('远场连接').fontSize(16)
        .fontColor(!this.nearActive ? '#FFFFFF' : '#333333')
        .padding({ top: 10, bottom: 10 })
        .layoutWeight(1)
        .textAlign(TextAlign.Center)
        .backgroundColor(!this.nearActive ? '#0A59F7' : '#00000000')
        .borderRadius(18)
        .onClick(() => { this.nearActive = false; })
    }
    .width('94%')
    .padding(4)
    .backgroundColor('#EEEEEE')
    .borderRadius(22)
  }

  @Builder
  private EntryCard(title: string, sub: string, char: string, onClick: () => void) {
    Row({ space: 14 }) {
      Text(char)
        .width(46).height(46)
        .fontSize(22)
        .textAlign(TextAlign.Center)
        .borderRadius(23)
        .backgroundColor('#0A59F7')
      Column({ space: 4 }) {
        Text(title).fontSize(18).fontWeight(FontWeight.Medium)
        Text(sub).fontSize(13).fontColor('#888888')
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      Image($r('sys.media.ohos_ic_public_arrow_right'))
        .width(20)
        .height(20)
        .fillColor('#AAAAAA')
    }
    .width('94%')
    .padding(16)
    .backgroundColor('#F6F8FA')
    .borderRadius(16)
    .margin({ bottom: 12 })
    .onClick(onClick)
  }

  build() {
    Column() {
      Row() {
        Text('PhotoTrans').fontSize(26).fontWeight(FontWeight.Bold)
        Blank()
        Text(this.modelLabel)
          .fontSize(12).fontColor('#0A59F7')
          .padding({ left: 10, right: 10, top: 4, bottom: 4 })
          .backgroundColor('#E6EEFF')
          .borderRadius(12)
      }
      .width('100%')
      .padding({ left: 20, right: 20, top: 64, bottom: 16 })

      this.ModeSwitch()

      Blank().height(24)

      if (this.nearActive) {
        this.EntryCard('设备列表', '近场自动发现局域网设备', 'N', () => {
          router.pushUrl({ url: 'pages/DeviceList' });
        })
      } else {
        this.EntryCard('远场连接', '扫码或输入 IP 直连', 'F', () => {
          router.pushUrl({ url: 'pages/FarConnect' });
        })
      }

      this.EntryCard('格式模型', '识别不同品牌照片格式', 'M', () => {
        router.pushUrl({ url: 'pages/ModelManagement' });
      })

      this.EntryCard('设置', '端口、模型、关于', 'S', () => {
        router.pushUrl({ url: 'pages/Settings' });
      })

      Blank()

      if (this.showProgressCard && this.currentProgress) {
        Row({ space: 12 }) {
          Progress({ value: this.currentProgress.overallPercent, total: 100, type: ProgressType.Ring })
            .width(46).height(46)
            .color('#0A59F7')
          Column({ space: 4 }) {
            Text(this.receivingStatus).fontSize(15).fontWeight(FontWeight.Medium)
            Text(this.currentProgress.overallPercent + '%')
              .fontSize(13).fontColor('#0A59F7')
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
          Button('详情')
            .fontSize(14)
            .backgroundColor('#0A59F7')
            .onClick(() => {
              router.pushUrl({ url: 'pages/TransferProgress' });
            })
        }
        .width('92%')
        .padding(14)
        .backgroundColor('#F1F6FF')
        .borderRadius(14)
        .margin({ bottom: 40 })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFFFFF')
  }
}