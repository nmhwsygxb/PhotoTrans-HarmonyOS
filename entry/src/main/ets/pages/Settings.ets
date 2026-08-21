/**
 * Settings.ets
 *
 * 设置页面。
 */
@Entry
@Component
struct Settings {
  build() {
    Column() {
      Text('设置')
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
        .margin(20)
      Text('应用设置')
        .fontSize(14)
        .fontColor('#888888')
        .margin({ bottom: 30 })
      Text('（设置功能开发中）')
        .fontSize(14)
        .fontColor('#aaaaaa')
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}