/**
 * ModelManagement.ets
 *
 * 格式检测模型管理页面。
 */
@Entry
@Component
struct ModelManagement {
  build() {
    Column() {
      Text('模型管理')
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
        .margin(20)
      Text('管理格式检测模型库')
        .fontSize(14)
        .fontColor('#888888')
        .margin({ bottom: 30 })
      Text('（模型管理功能开发中）')
        .fontSize(14)
        .fontColor('#aaaaaa')
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}