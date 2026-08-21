/**
 * FarConnect.ets
 *
 * 远场连接页面（扫码或手动输入 IP）。
 */
@Entry
@Component
struct FarConnect {
  build() {
    Column() {
      Text('远场连接')
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
        .margin(20)
      Text('通过 IP 地址直连远程设备')
        .fontSize(14)
        .fontColor('#888888')
        .margin({ bottom: 30 })
      Text('（扫码功能开发中）')
        .fontSize(14)
        .fontColor('#aaaaaa')
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}