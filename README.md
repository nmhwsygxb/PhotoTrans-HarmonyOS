# PhotoTrans (HarmonyOS)

> 跨品牌照片/文件无线传输 - HarmonyOS (ArkTS) 实现。
> TCP 直连 + PT-HI 握手 + HTTP PUT 文件传输（与 Android 和 iOS 协议兼容）。

## 功能

- 近场 (UDP 广播发现) 和远场 (IP 直连) 两种连接模式
- 文件 / 文件夹 / 照片批量传输
- 智能格式识别
- 支持 HDR / 动态照片

## 项目结构

```
entry/src/main/
  module.json5                   模块配置
  resources/                     资源文件
  ets/
    entryability/EntryAbility.ets    入口
    pages/Index.ets                  主页面
    models/DataModels.ts             数据模型 / 协议定义
    services/NetworkService.ts       网络服务 (TCP+PT-HI+HTTP PUT)
    services/DiscoveryService.ts     设备发现 (UDP 广播)
```

## 构建方式

### 使用 DevEco Studio (Windows)

1. 安装 [DevEco Studio](https://developer.harmonyos.com/cn/develop/deveco-studio)
2. 配置签名证书
3. 打开项目目录，同步后运行
4. 生成 HAP 安装包

### 侧载到手机

1. 在 DevEco Studio 中构建 HAP
2. 使用 `hdc install` 命令安装到设备
3. 或通过 DevEco Studio 的 Run 直接部署

## 传输协议 (与 Android/iOS 兼容)

### 握手
```
S→R:  PT-HI <deviceName>\n
R→S:  PT-HI <deviceName>\n
```
### 文件传输
```
S→R:  PUT /<filename> HTTP/1.1\r\nContent-Length: <n>\r\n\r\n<raw bytes>
R→S:  HTTP/1.1 200 OK\r\n\r\n
```

## 开源协议

MIT License