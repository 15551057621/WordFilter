//LiteLoaderScript Dev Helper
/// <reference path="/root/VSCode/Library/JS/index.d.ts" /> 

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const isLSE = typeof mc !== 'undefined' && typeof ll !== 'undefined';
const isNode = !isLSE && typeof process !== 'undefined' && process.versions?.node;

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

let Logger = {
    info: (...args) => console.log('[SensitiveFilter]', ...args),
    warn: (...args) => console.warn('[SensitiveFilter]', ...args),
    error: (...args) => console.error('[SensitiveFilter]', ...args)
};

if (isLSE) {
    logger.setTitle("SensitiveFilter");
    Logger = {
        info: (...args) => logger.log(...args),
        warn: (...args) => logger.warn(...args),
        error: (...args) => logger.error(...args)
    }
}

// ==================== AC 自动机核心引擎 ====================
class ACAutomaton {
    constructor() {
        this.root = { next: {}, fail: null, output: null };
        this.size = 0;
    }

    build(words) {
        const startTime = Date.now();

        const validWords = [...words]
            .filter(w => w && w.length <= 50)
            .sort((a, b) => b.length - a.length);

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

    static async init() {
        if (this.#isReady) return true;

        try {
            const allWords = new Set();

            // 获取词库路径
            let wordlistPath;
            if (isLSE) {
                wordlistPath = path.join(process.cwd(), 'plugins', 'WordFilter', 'wordlist');
            } else {
                wordlistPath = CONFIG.WORD_LIST_PATH;
            }

            Logger.info(`词库目录: ${wordlistPath}`);

            // 检查目录是否存在
            try {
                await fs.promises.access(wordlistPath);
            } catch (e) {
                Logger.error(`词库目录不存在: ${wordlistPath}`);
                Logger.info('请创建目录并放入 .txt 词库文件');
                return false;
            }

            const files = await fs.promises.readdir(wordlistPath);
            const txtFiles = files.filter(f => f.endsWith('.txt'));

            if (txtFiles.length === 0) {
                Logger.warn(`未找到 .txt 词库文件`);
                return false;
            }

            for (const file of txtFiles) {
                const content = await fs.promises.readFile(path.join(wordlistPath, file), 'utf-8');
                const words = content.split(/\r?\n/)
                    .map(w => w.trim().toLowerCase())
                    .filter(w => w && !w.startsWith('#') && w.length <= 50);
                words.forEach(w => allWords.add(w));
                Logger.info(`加载: ${file} -> ${words.length} 词`);
            }

            const wordList = [...allWords];
            this.#wordCount = wordList.length;

            if (this.#wordCount === 0) {
                Logger.error('词库为空');
                return false;
            }

            this.#engine = new ACAutomaton();
            this.#engine.build(wordList);
            this.#isReady = true;

            Logger.info(`初始化完成 | 词库: ${this.#wordCount}词 | 节点: ${this.#engine.size}`);
            return true;

        } catch (error) {
            Logger.error('初始化失败:', error.message);
            return false;
        }
    }

    static detect(text) {
        if (!this.#isReady || !text) return false;

        if (CONFIG.ENABLE_CACHE) {
            const cached = this.#detectCache.get(text);
            if (cached !== undefined) return cached;
        }

        const chunks = TextChunker.split(text, CONFIG.CHUNK_SIZE);
        let result = false;
        for (const chunk of chunks) {
            if (this.#engine.contains(chunk)) {
                result = true;
                break;
            }
        }

        if (CONFIG.ENABLE_CACHE && this.#detectCache.size < CONFIG.CACHE_SIZE) {
            this.#detectCache.set(text, result);
        }

        return result;
    }

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

    static getStatus() {
        return {
            isReady: this.#isReady,
            wordCount: this.#wordCount,
            cacheSize: this.#detectCache.size,
            filterCacheSize: this.#filterCache.size,
            nodeCount: this.#engine?.size || 0
        };
    }

    static clearCache() {
        this.#detectCache.clear();
        this.#filterCache.clear();
        Logger.info('缓存已清空');
    }

    static async reload() {
        this.#isReady = false;
        this.#detectCache.clear();
        this.#filterCache.clear();
        this.#engine = null;
        return await this.init();
    }
}

// ==================== 立即初始化 ====================
// 同步执行初始化（不使用事件监听）
let initPromise = null;

function startInit() {
    if (initPromise) return initPromise;
    initPromise = SensitiveFilter.init();
    return initPromise;
}

// 立即开始初始化
// startInit();

// ==================== LSE 环境 ====================
if (isLSE) {
    SensitiveFilter.init().catch(err => {
        Logger.error('初始化失败:', err);
    });
    
    // 导出 API
    ll.exports((text) => SensitiveFilter.detect(text), 'WordFilter', 'contains');
    ll.exports((text) => SensitiveFilter.sanitize(text), 'WordFilter', 'filter');
    ll.exports((text) => SensitiveFilter.match(text), 'WordFilter', 'match');
    ll.exports(() => SensitiveFilter.getStatus(), 'WordFilter', 'status');
    ll.exports(() => SensitiveFilter.reload(), 'WordFilter', 'reload');
    ll.exports(() => SensitiveFilter.clearCache(), 'WordFilter', 'clearCache');

    Logger.info('插件已加载 | 导出 API: contains, filter, match, status, reload, clearCache');
}

// ==================== Node.js 测试环境 ====================
if (isNode) {
    (async () => {
        console.log('\n敏感词过滤测试工具\n');

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

// ==================== 导出模块 ====================
if (isNode) {
    module.exports = {
        contains: (text) => SensitiveFilter.detect(text),
        filter: (text) => SensitiveFilter.sanitize(text),
        match: (text) => SensitiveFilter.match(text),
        status: () => SensitiveFilter.getStatus(),
        reload: () => SensitiveFilter.reload(),
        clearCache: () => SensitiveFilter.clearCache(),
        SensitiveFilter,
        ACAutomaton,
        TextChunker,
        version: '1.0.0',
        config: CONFIG
    };
}