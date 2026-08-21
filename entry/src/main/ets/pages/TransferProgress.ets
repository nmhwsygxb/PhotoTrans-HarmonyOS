/**
 * TransferProgress.ets
 *
 * 传输进度页面。
 */
@Entry
@Component
struct TransferProgress {
  build() {
    Column() {
      Text('传输进度')
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
        .margin(20)
      Text('文件传输进度详情')
        .fontSize(14)
        .fontColor('#888888')
        .margin({ bottom: 30 })
      Text('（传输进度显示开发中）')
        .fontSize(14)
        .fontColor('#aaaaaa')
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}