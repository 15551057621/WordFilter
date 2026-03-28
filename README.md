# WordFilter — 屏蔽词过滤插件

## 🚀 插件概述

WordFilter 是一个高性能敏感词过滤前置库  
基于 AC自动机（Aho-Corasick） 算法实现，支持百万级词库毫秒级响应。  
作为前置库，它不主动拦截任何消息，仅导出 API 供其他插件调用。

## ✨ 核心特性

- 高性能 - 单次检测 < 0.3ms，缓存命中 < 0.01ms
- 跨平台 - 同时支持 LSE-Node 和纯 Node.js 环境
- 结果缓存 - 相同文本直接返回缓存结果
- 长文本支持 - 自动分片处理，支持任意长度文本
- AC自动机算法 - O(n) 时间复杂度，与词库大小无关

>> 在纯 Node.js 环境下使用时需要手动修改本项目源码 （因为我没搞懂npm导出）

## 📂 词库格式

词库文件为 .txt 文本文件，每行一个敏感词，支持 # 注释：

```
# 敏感词库示例
# 每行一个敏感词
敏感词1
咕咕嘎嘎
```

>> 注意：词库文件放入 wordlist/ 目录，支持多个文件，插件会自动合并。

## ⚙️ 配置说明

修改 index.js 中的 CONFIG 对象：

```javascript
const CONFIG = Object.freeze({
    WORD_LIST_PATH: './wordlist/',     // 词库目录
    REPLACE_CHAR: '喵',                  // 替换字符
    ENABLE_CACHE: true,                 // 启用缓存
    CACHE_SIZE: 5000,                   // 缓存大小
    CHUNK_SIZE: 512,                    // 分片大小
});
```

## 📁 文件结构

```
WordFilter/
├── index.js           # 主程序
├── package.json       # npm 配置
├── manifest.json      # LSE 插件清单
└── wordlist/          # 词库目录
    ├── words_1.txt
    ├── words_2.txt
    └── words_3.txt
```

## 🔌 API 接口文档

```javascript
const WFLib = { // 导入 API
    contains = ll.imports('WordFilter', 'contains'),
    filter = ll.imports('WordFilter', 'filter'),
    match = ll.imports('WordFilter', 'match'),
    status = ll.imports('WordFilter', 'status'),
    reload = ll.imports('WordFilter', 'reload'),
    clearCache = ll.imports('WordFilter', 'clearCache')
}
```

#### 检测文本是否包含敏感词
`WFLib.contains(text)`

- 参数：
  - text : String
    待检测的文本内容
- 返回值：是否包含敏感词
- 返回值类型：Boolean

#### 过滤文本中的敏感词
`WFLib.filter(text)`

- 参数：
  - text : String
    待过滤的文本内容
- 返回值：过滤后的文本（敏感词替换为 *）
- 返回值类型：String

#### 获取匹配的敏感词列表
`WFLib.match(text)`

- 参数：
  - text : String
    待检测的文本内容
- 返回值：匹配到的敏感词列表（自动去重）
- 返回值类型：Array<String>

#### 获取过滤器状态信息
`WFLib.status()`

- 参数：无
- 返回值：过滤器当前状态对象
- 返回值类型：Object

返回值结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| isReady | Boolean | 过滤器是否已初始化完成 |
| wordCount | Integer | 词库中的敏感词数量 |
| cacheSize | Integer | 检测结果缓存大小 |
| nodeCount | Integer | AC自动机节点数量 |
| filterCacheSize | Integer | 过滤结果缓存大小 |

#### 重新加载词库
`WFLib.reload()`

- 参数：无
- 返回值：是否重新加载成功
- 返回值类型：Promise<Boolean>

#### 清空缓存
`WFLib.clearCache()`

- 参数：无
- 返回值：无
- 返回值类型：void
