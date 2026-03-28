//LiteLoaderScript Dev Helper
/// <reference path="/root/VSCode/Library/JS/index.d.ts" /> 

const isLSE = typeof mc !== 'undefined' && typeof ll !== 'undefined';
const isNode = !isLSE && typeof process !== 'undefined' && process.versions?.node;

const CONFIG = Object.freeze({
    WORD_LIST_PATH: typeof mc !== 'undefined' ? './plugins/SensitiveFilter/wordlist/' : './wordlist/',
    REPLACE_CHAR: "喵",

    // 性能配置
    CHUNK_SIZE: 512,
    ENABLE_CACHE: true,
    CACHE_SIZE: 5000,
    MAX_TEXT_LENGTH: 0  // 0 = 不限制
});

// ==================== 高性能 AC 自动机 ====================
class HighPerformanceAC {
    constructor() {
        this.root = { next: {}, fail: null, output: null };
        this.size = 0;
    }

    build(words) {
        const startTime = Date.now();

        const sortedWords = [...words]
            .filter(w => w && w.length <= 50)
            .sort((a, b) => b.length - a.length);

        // 构建 Trie 树
        for (const word of sortedWords) {
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

        // 构建失败指针
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
                    if (!child.output) {
                        child.output = [];
                    }
                    if (!Array.isArray(child.output)) {
                        child.output = [child.output];
                    }
                    if (Array.isArray(child.fail.output)) {
                        child.output.push(...child.fail.output);
                    } else {
                        child.output.push(child.fail.output);
                    }
                }
                queue.push(child);
            }
        }

        console.log(`✅ 构建完成 | 词数: ${sortedWords.length} | 节点: ${this.size} | 耗时: ${Date.now() - startTime}ms`);
    }

    // 极速检测
    containsFast(text) {
        let node = this.root;
        const len = text.length;

        for (let i = 0; i < len; i++) {
            const ch = text[i];
            let next = node.next[ch];
            if (next) {
                node = next;
                if (node.output) return true;
                continue;
            }

            let fail = node.fail;
            while (fail && !fail.next[ch]) {
                fail = fail.fail;
            }
            node = fail ? fail.next[ch] : this.root;
            if (node && node.output) return true;
        }
        return false;
    }

    // 极速过滤
    filterFast(text, replaceChar = '*') {
        const result = new Array(text.length);
        const matched = new Uint8Array(text.length);
        let node = this.root;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            let next = node.next[ch];
            if (next) {
                node = next;
                if (node.output) {
                    // 确保 outputs 是数组
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
            while (fail && !fail.next[ch]) {
                fail = fail.fail;
            }
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
class FastChunker {
    static split(text, chunkSize) {
        if (text.length <= chunkSize) return [text];

        const chunks = [];
        let start = 0;

        while (start < text.length) {
            let end = Math.min(start + chunkSize, text.length);

            if (end < text.length) {
                const boundaryChars = new Set(['.', '。', '?', '？', '!', '！', '\n', ' ', '，', ',', ';', '；', '、']);
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

// ==================== 高性能敏感词过滤器 ====================
class HighPerformanceFilter {
    static #ac = null;
    static #isReady = false;
    static #wordCount = 0;
    static #cache = new Map();
    static #filterCache = new Map();

    static async load() {
        const startTime = Date.now();

        try {
            const allWords = new Set();

            if (isLSE) {
                // LSE 环境文件读取
                const files = File.getFilesList(CONFIG.WORD_LIST_PATH);
                const txtFiles = files.filter(f => f.endsWith('.txt'));

                if (txtFiles.length === 0) {
                    console.warn('未找到词库文件');
                    return false;
                }

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
                // Node.js 环境文件读取
                const fs = await import('fs').then(m => m.promises);
                const path = await import('path');
                const files = await fs.readdir(CONFIG.WORD_LIST_PATH);
                const txtFiles = files.filter(f => f.endsWith('.txt'));

                for (const file of txtFiles) {
                    const content = await fs.readFile(path.join(CONFIG.WORD_LIST_PATH, file), 'utf-8');
                    const words = content.split(/\r?\n/)
                        .map(w => w.trim().toLowerCase())
                        .filter(w => w && !w.startsWith('#') && w.length <= 50);
                    words.forEach(w => allWords.add(w));
                }
            }

            const wordList = [...allWords];
            HighPerformanceFilter.#wordCount = wordList.length;

            HighPerformanceFilter.#ac = new HighPerformanceAC();
            HighPerformanceFilter.#ac.build(wordList);
            HighPerformanceFilter.#isReady = true;

            console.log(`📚 加载完成 | 词数: ${HighPerformanceFilter.#wordCount} | 耗时: ${Date.now() - startTime}ms`);
            return true;

        } catch (error) {
            console.error('加载失败:', error);
            return false;
        }
    }

    static contains(text) {
        if (!HighPerformanceFilter.#isReady || !text) return false;

        if (CONFIG.ENABLE_CACHE) {
            const cached = HighPerformanceFilter.#cache.get(text);
            if (cached !== undefined) return cached;
        }

        const chunks = FastChunker.split(text, CONFIG.CHUNK_SIZE);
        let result = false;

        for (const chunk of chunks) {
            if (HighPerformanceFilter.#ac.containsFast(chunk)) {
                result = true;
                break;
            }
        }

        if (CONFIG.ENABLE_CACHE && HighPerformanceFilter.#cache.size < CONFIG.CACHE_SIZE) {
            HighPerformanceFilter.#cache.set(text, result);
        }

        return result;
    }

    static filter(text) {
        if (!HighPerformanceFilter.#isReady || !text) return text;

        if (CONFIG.ENABLE_CACHE) {
            const cached = HighPerformanceFilter.#filterCache.get(text);
            if (cached !== undefined) return cached;
        }

        const chunks = FastChunker.split(text, CONFIG.CHUNK_SIZE);
        const filtered = chunks.map(chunk =>
            HighPerformanceFilter.#ac.filterFast(chunk, CONFIG.REPLACE_CHAR)
        ).join('');

        if (CONFIG.ENABLE_CACHE && HighPerformanceFilter.#filterCache.size < CONFIG.CACHE_SIZE) {
            HighPerformanceFilter.#filterCache.set(text, filtered);
        }

        return filtered;
    }

    static getStatus() {
        return {
            isReady: HighPerformanceFilter.#isReady,
            wordCount: HighPerformanceFilter.#wordCount,
            cacheSize: HighPerformanceFilter.#cache.size,
            filterCacheSize: HighPerformanceFilter.#filterCache.size,
            nodeCount: HighPerformanceFilter.#ac?.size || 0,
            config: {
                chunkSize: CONFIG.CHUNK_SIZE,
                maxTextLength: CONFIG.MAX_TEXT_LENGTH || '无限制',
                cacheEnabled: CONFIG.ENABLE_CACHE
            }
        };
    }

    static clearCache() {
        HighPerformanceFilter.#cache.clear();
        HighPerformanceFilter.#filterCache.clear();
        console.log('缓存已清空');
    }
}

// ==================== LSE 环境 ====================
if (isLSE) {
    let isLoaded = false;

    mc.listen('onServerStarted', () => {
        console.log('[敏感词过滤] 加载词库...');
        HighPerformanceFilter.load().then(() => {
            isLoaded = true;
            const status = HighPerformanceFilter.getStatus();
            console.log(`[敏感词过滤] 就绪 | 词库: ${status.wordCount} | 无长度限制`);
        }).catch(err => {
            console.error('[敏感词过滤] 加载失败:', err);
        });
    });

    mc.listen('onChat', (player, msg) => {
        if (!isLoaded) return true;
        if (player.isOP()) return true;

        if (HighPerformanceFilter.contains(msg)) {
            return false;
        }
        return true;
    });

    ll.exports((text) => HighPerformanceFilter.contains(text), 'SensitiveFilter', 'contains');
    ll.exports((text) => HighPerformanceFilter.filter(text), 'SensitiveFilter', 'filter');
    ll.exports(() => HighPerformanceFilter.getStatus(), 'SensitiveFilter', 'status');
    ll.exports(() => HighPerformanceFilter.clearCache(), 'SensitiveFilter', 'clearCache');

    console.log('[敏感词过滤] 插件已加载');
}

// ==================== Node.js 测试 ====================
if (isNode) {
    (async () => {
        console.log('\n⚡ 敏感词过滤测试（无长度限制）\n');

        const success = await HighPerformanceFilter.load();

        if (!success) {
            console.log('❌ 词库加载失败，请检查 wordlist 目录');
            process.exit(1);
        }

        const status = HighPerformanceFilter.getStatus();
        console.log(`📊 词库: ${status.wordCount}词 | 节点: ${status.nodeCount}`);
        console.log(`⚙️  分片: ${status.config.chunkSize} | 长度限制: ${status.config.maxTextLength}`);
        console.log(`💾 缓存: ${status.config.cacheEnabled ? '启用' : '禁用'}\n`);

        // 测试词库是否有效
        console.log('🧪 词库有效性测试...');
        const testWords = ['敏感词1', '敏感词2', '敏感词3'];
        for (const word of testWords) {
            const result = HighPerformanceFilter.contains(word);
            console.log(`   "${word}": ${result ? '✅ 检测到' : '❌ 未检测到'}`);
        }

        // 长文本测试
        console.log('\n🧪 长文本测试...');
        const longText = '这是一段非常长的文本' + '包含敏感词1的内容'.repeat(100);
        console.log(`   文本长度: ${longText.length}字符`);

        const start = Date.now();
        const result = HighPerformanceFilter.contains(longText);
        const elapsed = Date.now() - start;
        console.log(`   检测结果: ${result ? '⚠️ 包含敏感词' : '✅ 通过'}`);
        console.log(`   耗时: ${elapsed}ms\n`);

        // 性能测试
        console.log('🧪 性能测试 (100次检测)...');
        const testTexts = [
            '这是一段正常文本',
            '包含肛门的文本',
            '这是一段正常文本安安安安安安安安安安安安安',
            '包含肛门的文本aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        ];

        const totalTests = 10000;
        const perfStart = Date.now();
        let detectedCount = 0;

        for (let i = 0; i < totalTests; i++) {
            const text = testTexts[i % testTexts.length];
            if (HighPerformanceFilter.contains(text)) detectedCount++;
        }

        const perfElapsed = Date.now() - perfStart;
        console.log(`   总请求: ${totalTests}`);
        console.log(`   检测到敏感词: ${detectedCount}`);
        console.log(`   总耗时: ${perfElapsed}ms`);
        console.log(`   平均延迟: ${(perfElapsed / totalTests).toFixed(2)}ms/次`);

        // 内存状态
        const mem = process.memoryUsage();
        console.log(`\n💾 内存: ${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.rss / 1024 / 1024)}MB`);

        // 交互模式
        console.log('\n💡 输入文本测试，输入 "exit" 退出');
        console.log('📌 无长度限制，支持任意长度文本\n');

        const readline = await import('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const test = (input) => {
            if (input === 'exit') {
                console.log('\n👋 退出');
                rl.close();
                process.exit(0);
                return;
            }

            const perfStart = Date.now();
            const contains = HighPerformanceFilter.contains(input);
            const filtered = HighPerformanceFilter.filter(input);
            const elapsed = Date.now() - perfStart;

            console.log(`\n📝 长度: ${input.length}字符 | 耗时: ${elapsed}ms`);
            console.log(`🔍 结果: ${contains ? '⚠️ 包含敏感词' : '✅ 通过'}`);
            if (contains && filtered !== input) {
                const displayFiltered = filtered.length > 100 ? filtered.substring(0, 100) + '...' : filtered;
                console.log(`✨ 过滤: ${displayFiltered}`);
            }
            console.log('');
        };

        rl.on('line', test);
    })();
}