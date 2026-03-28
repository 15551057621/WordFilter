//LiteLoaderScript Dev Helper
/// <reference path="/root/VSCode/Library/JS/index.d.ts" /> 

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const isLSE = typeof mc !== 'undefined' && typeof ll !== 'undefined';
const isNode = !isLSE && typeof process !== 'undefined' && process.versions?.node;

// ==================== 配置模块 ====================
const CONFIG = Object.freeze({
    // 词库位置
    WORD_LIST_PATH: isLSE ? './plugins/WordFilter/wordlist/' : './wordlist/',

    // 过滤配置
    REPLACE_CHAR: '喵', // 替换字符 || 当检测到敏感词时，会用这个字符替换敏感词的每个字符
    ENABLE_CACHE: true, // 启用缓存 || 提升重复文本检测性能
    CACHE_SIZE: 5000, // 缓存大小 || 缓存最多存储多少条检测结果
    CHUNK_SIZE: 512, // 分片大小 || 长文本会被分割成多个小块分别检测，分片大小直接影响检测性能
    MAX_TEXT_LENGTH: 0,  // 最大检测长度 || 超过此长度的文本直接拦截 0 = 不限制
});

// ==================== 日志工具 ====================
const Logger = {
    info: (...args) => console.log('[SensitiveFilter]', ...args),
    warn: (...args) => console.warn('[SensitiveFilter]', ...args),
    error: (...args) => console.error('[SensitiveFilter]', ...args)
};

// ==================== AC 自动机核心引擎 ====================
class ACAutomaton {
    constructor() {
        this.root = { next: {}, fail: null, output: null };
        this.size = 0;
    }

    build(words) {
        const startTime = Date.now();

        // 过滤并排序（长词优先）
        const validWords = [...words]
            .filter(w => w && w.length <= 50)
            .sort((a, b) => b.length - a.length);

        // 构建 Trie 树
        for (const word of validWords) {
            let node = this.root;
            for (let i = 0; i < word.length; i++) {
                const ch = word[i];
                if (!node.next[ch]) {
                    node.next[ch] = { next: {}, fail: null, output: null };
                    this.size++;
                }
                node = node.next[ch];
            }
            node.output = word;
        }

        // 构建失败指针（BFS）
        const queue = [];
        for (const [ch, child] of Object.entries(this.root.next)) {
            child.fail = this.root;
            queue.push(child);
        }

        while (queue.length > 0) {
            const current = queue.shift();
            for (const [ch, child] of Object.entries(current.next)) {
                let fail = current.fail;
                while (fail && !fail.next[ch]) {
                    fail = fail.fail;
                }
                child.fail = fail ? fail.next[ch] : this.root;

                // 合并输出
                if (child.fail && child.fail.output) {
                    if (!child.output) child.output = [];
                    if (!Array.isArray(child.output)) child.output = [child.output];
                    if (Array.isArray(child.fail.output)) {
                        child.output.push(...child.fail.output);
                    } else {
                        child.output.push(child.fail.output);
                    }
                }
                queue.push(child);
            }
        }

        Logger.info(`构建完成 | 词数: ${validWords.length} | 节点: ${this.size} | 耗时: ${Date.now() - startTime}ms`);
        return this;
    }

    // 快速检测
    contains(text) {
        let node = this.root;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            let next = node.next[ch];
            if (next) {
                node = next;
                if (node.output) return true;
                continue;
            }

            let fail = node.fail;
            while (fail && !fail.next[ch]) fail = fail.fail;
            node = fail ? fail.next[ch] : this.root;
            if (node && node.output) return true;
        }
        return false;
    }

    // 快速过滤
    filter(text, replaceChar = '*') {
        const result = new Array(text.length);
        const matched = new Uint8Array(text.length);
        let node = this.root;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            let next = node.next[ch];
            if (next) {
                node = next;
                if (node.output) {
                    const outputs = Array.isArray(node.output) ? node.output : [node.output];
                    for (const word of outputs) {
                        const start = i - word.length + 1;
                        if (start >= 0) {
                            for (let j = start; j <= i; j++) matched[j] = 1;
                        }
                    }
                }
                result[i] = ch;
                continue;
            }

            let fail = node.fail;
            while (fail && !fail.next[ch]) fail = fail.fail;
            node = fail ? fail.next[ch] : this.root;
            if (node && node.output) {
                const outputs = Array.isArray(node.output) ? node.output : [node.output];
                for (const word of outputs) {
                    const start = i - word.length + 1;
                    if (start >= 0) {
                        for (let j = start; j <= i; j++) matched[j] = 1;
                    }
                }
            }
            result[i] = ch;
        }

        for (let i = 0; i < matched.length; i++) {
            if (matched[i]) result[i] = replaceChar;
        }
        return result.join('');
    }
}

// ==================== 文本分片器 ====================
class TextChunker {
    static split(text, chunkSize) {
        if (text.length <= chunkSize) return [text];

        const chunks = [];
        let start = 0;
        const boundaryChars = new Set(['.', '。', '?', '？', '!', '！', '\n', ' ', '，', ',', ';', '；', '、']);

        while (start < text.length) {
            let end = Math.min(start + chunkSize, text.length);

            if (end < text.length) {
                for (let i = Math.min(end + 10, text.length - 1); i > start; i--) {
                    if (boundaryChars.has(text[i])) {
                        end = i + 1;
                        break;
                    }
                }
            }
            chunks.push(text.substring(start, end));
            start = end;
        }
        return chunks;
    }
}

// ==================== 敏感词过滤器核心 ====================
class SensitiveFilter {
    static #engine = null;
    static #isReady = false;
    static #wordCount = 0;
    static #detectCache = new Map();
    static #filterCache = new Map();

    // 初始化
    static async init() {
        if (this.#isReady) return true;

        try {
            const allWords = new Set();

            /*if (isLSE) {
                const files = File.getFilesList(CONFIG.WORD_LIST_PATH);
                const txtFiles = files.filter(f => f.endsWith('.txt'));

                for (const file of txtFiles) {
                    const content = File.readFrom(CONFIG.WORD_LIST_PATH + file);
                    if (content) {
                        const words = content.split(/\r?\n/)
                            .map(w => w.trim().toLowerCase())
                            .filter(w => w && !w.startsWith('#') && w.length <= 50);
                        words.forEach(w => allWords.add(w));
                    }
                }
            } else {
                const files = await fs.promises.readdir(CONFIG.WORD_LIST_PATH);
                const txtFiles = files.filter(f => f.endsWith('.txt'));

                for (const file of txtFiles) {
                    const content = await fs.promises.readFile(path.join(CONFIG.WORD_LIST_PATH, file), 'utf-8');
                    
                }
            }*/

            // 统一使用 Node.js fs 模块读取文件（LSE-Node 支持）
            const files = await fs.promises.readdir(CONFIG.WORD_LIST_PATH);
            const txtFiles = files.filter(f => f.endsWith('.txt'));

            for (const file of txtFiles) {
                const content = await fs.promises.readFile(path.join(CONFIG.WORD_LIST_PATH, file), 'utf-8');
                const words = content.split(/\r?\n/)
                    .map(w => w.trim().toLowerCase())
                    .filter(w => w && !w.startsWith('#') && w.length <= 50);
                words.forEach(w => allWords.add(w));
            }

            const wordList = [...allWords];
            this.#wordCount = wordList.length;

            this.#engine = new ACAutomaton();
            this.#engine.build(wordList);
            this.#isReady = true;

            Logger.info(`初始化完成 | 词库: ${this.#wordCount}词 | 节点: ${this.#engine.size}`);
            return true;

        } catch (error) {
            Logger.error('初始化失败:', error);
            return false;
        }
    }

    // 检测文本
    static detect(text) {
        if (!this.#isReady || !text) return false;

        // 缓存检查
        if (CONFIG.ENABLE_CACHE) {
            const cached = this.#detectCache.get(text);
            if (cached !== undefined) return cached;
        }

        // 分片检测
        const chunks = TextChunker.split(text, CONFIG.CHUNK_SIZE);
        let result = false;
        for (const chunk of chunks) {
            if (this.#engine.contains(chunk)) {
                result = true;
                break;
            }
        }

        // 缓存结果
        if (CONFIG.ENABLE_CACHE && this.#detectCache.size < CONFIG.CACHE_SIZE) {
            this.#detectCache.set(text, result);
        }

        return result;
    }

    // 过滤文本
    static sanitize(text) {
        if (!this.#isReady || !text) return text;

        if (CONFIG.ENABLE_CACHE) {
            const cached = this.#filterCache.get(text);
            if (cached !== undefined) return cached;
        }

        const chunks = TextChunker.split(text, CONFIG.CHUNK_SIZE);
        const result = chunks.map(chunk =>
            this.#engine.filter(chunk, CONFIG.REPLACE_CHAR)
        ).join('');

        if (CONFIG.ENABLE_CACHE && this.#filterCache.size < CONFIG.CACHE_SIZE) {
            this.#filterCache.set(text, result);
        }

        return result;
    }

    // 获取匹配的敏感词列表
    static match(text) {
        if (!this.#isReady || !text) return [];

        const matched = new Set();
        const chunks = TextChunker.split(text, CONFIG.CHUNK_SIZE);

        for (const chunk of chunks) {
            let node = this.#engine.root;
            for (let i = 0; i < chunk.length; i++) {
                const ch = chunk[i];
                let next = node.next[ch];
                if (next) {
                    node = next;
                    if (node.output) {
                        const outputs = Array.isArray(node.output) ? node.output : [node.output];
                        outputs.forEach(w => matched.add(w));
                    }
                    continue;
                }

                let fail = node.fail;
                while (fail && !fail.next[ch]) fail = fail.fail;
                node = fail ? fail.next[ch] : this.#engine.root;
                if (node && node.output) {
                    const outputs = Array.isArray(node.output) ? node.output : [node.output];
                    outputs.forEach(w => matched.add(w));
                }
            }
        }

        return [...matched];
    }

    // 获取状态
    static getStatus() {
        return {
            isReady: this.#isReady,
            wordCount: this.#wordCount,
            cacheSize: this.#detectCache.size,
            filterCacheSize: this.#filterCache.size,
            nodeCount: this.#engine?.size || 0
        };
    }

    // 清空缓存
    static clearCache() {
        this.#detectCache.clear();
        this.#filterCache.clear();
        Logger.info('缓存已清空');
    }

    // 重新加载
    static async reload() {
        this.#isReady = false;
        this.#detectCache.clear();
        this.#filterCache.clear();
        this.#engine = null;
        return await this.init();
    }
}

// ==================== LSE 环境 ====================
if (isLSE) {
    // 服务器启动时初始化
    mc.listen('onServerStarted', async () => {
        Logger.info('正在初始化...');
        await SensitiveFilter.init();
        const status = SensitiveFilter.getStatus();
        Logger.info(`就绪 | 词库: ${status.wordCount}词 | 缓存: ${status.cacheSize}/${CONFIG.CACHE_SIZE}`);
    });

    // ==================== 导出 API 文档 ====================
    /**
     * @module SensitiveFilter
     * @description 敏感词过滤插件 API
     * 
     * @example
     * // 导入 API
     * const contains = ll.imports('SensitiveFilter', 'contains');
     * const filter = ll.imports('SensitiveFilter', 'filter');
     * const match = ll.imports('SensitiveFilter', 'match');
     * const status = ll.imports('SensitiveFilter', 'status');
     * const reload = ll.imports('SensitiveFilter', 'reload');
     * const clearCache = ll.imports('SensitiveFilter', 'clearCache');
     * 
     * // 检测是否包含敏感词
     * if (contains('这是一段文本')) {
     *     log('包含敏感词');
     * }
     * 
     * // 过滤敏感词
     * const clean = filter('这是一段包含敏感词的文本');
     * // 返回: "这是一段包含***的文本"
     * 
     * // 获取匹配的敏感词列表
     * const words = match('包含敏感词1和敏感词2的文本');
     * // 返回: ["敏感词1", "敏感词2"]
     * 
     * // 获取过滤器状态
     * const stats = status();
     * // 返回: { isReady, wordCount, cacheSize, nodeCount }
     * 
     * // 重新加载词库
     * await reload();
     * 
     * // 清空缓存
     * clearCache();
     */

    ll.exports((text) => SensitiveFilter.detect(text), 'SensitiveFilter', 'contains');
    ll.exports((text) => SensitiveFilter.sanitize(text), 'SensitiveFilter', 'filter');
    ll.exports((text) => SensitiveFilter.match(text), 'SensitiveFilter', 'match');
    ll.exports(() => SensitiveFilter.getStatus(), 'SensitiveFilter', 'status');
    ll.exports(() => SensitiveFilter.reload(), 'SensitiveFilter', 'reload');
    ll.exports(() => SensitiveFilter.clearCache(), 'SensitiveFilter', 'clearCache');

    Logger.info('插件已加载 | 导出 API: contains, filter, match, status, reload, clearCache');
}

// ==================== Node.js 测试环境 ====================
if (isNode) {
    (async () => {
        console.log('\n🔧 敏感词过滤测试工具\n');

        await SensitiveFilter.init();

        const status = SensitiveFilter.getStatus();
        console.log(`词库: ${status.wordCount}词 | AC节点: ${status.nodeCount}`);
        console.log(`分片: ${CONFIG.CHUNK_SIZE} | 缓存: ${status.cacheSize}/${CONFIG.CACHE_SIZE}\n`);
        console.log('输入文本测试，输入 "exit" 退出\n');

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const test = (input) => {
            if (input === 'exit') {
                console.log('\n退出测试');
                rl.close();
                process.exit(0);
                return;
            }

            const memBefore = process.memoryUsage().heapUsed;
            const timeStart = Date.now();

            const hasSensitive = SensitiveFilter.detect(input);
            const filtered = SensitiveFilter.sanitize(input);
            const matched = SensitiveFilter.match(input);

            const timeEnd = Date.now();
            const memAfter = process.memoryUsage().heapUsed;

            console.log(`\n长度: ${input.length}字符`);
            console.log(`结果: ${hasSensitive ? '⚠️ 包含敏感词' : '✅ 通过'}`);
            if (matched.length > 0) {
                console.log(`匹配: ${matched.join(', ')}`);
            }
            if (hasSensitive && filtered !== input) {
                const display = filtered.length > 100 ? filtered.substring(0, 100) + '...' : filtered;
                console.log(`过滤: ${display}`);
            }
            console.log(`耗时: ${timeEnd - timeStart}ms`);
            console.log(`内存: ${Math.round((memAfter - memBefore) / 1024)}KB\n`);
        };

        rl.on('line', test);
    })();
}