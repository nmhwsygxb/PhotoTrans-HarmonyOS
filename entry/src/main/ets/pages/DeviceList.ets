/**
 * DeviceList.ets
 *
 * 局域网设备发现列表页面。
 */
@Entry
@Component
struct DeviceList {
  build() {
    Column() {
      Text('附近设备')
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
        .margin(20)
      Text('在同一 Wi-Fi 网络下自动发现设备')
        .fontSize(14)
        .fontColor('#888888')
        .margin({ bottom: 30 })
      Text('（设备发现功能开发中）')
        .fontSize(14)
        .fontColor('#aaaaaa')
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}