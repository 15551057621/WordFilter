// ==================== 配置文件（文件开头）====================
const CONFIG = Object.freeze({
    WORD_LIST_PATH: typeof mc !== 'undefined' ? './plugins/SensitiveFilter/wordlist/' : './wordlist/',
    REPLACE_CHAR: '喵',
    ENABLE_CACHE: true,
    CACHE_SIZE: 10000,
    BYPASS_OP: true,
    BLOCK_MESSAGE: '§c消息包含敏感词，请文明发言！',
    CHUNK_SIZE: 200,              // 分片大小（字符数）
    MAX_TEXT_LENGTH: 5000,        // 最大检测文本长度
    TIMEOUT_PER_CHUNK: 10         // 每个分片超时（毫秒）
});

// ==================== 环境检测 ====================
const isLSE = typeof mc !== 'undefined' && typeof ll !== 'undefined';
const isNode = !isLSE && typeof process !== 'undefined' && process.versions?.node;

// ==================== AC自动机 ====================
class AhoCorasick {
    constructor() {
        this.root = { next: {}, fail: null, output: null };
        this.size = 0;
    }

    build(words) {
        const startTime = Date.now();

        for (const word of words) {
            if (!word) continue;
            let node = this.root;
            for (const ch of word) {
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
                while (fail && !fail.next[ch]) fail = fail.fail;
                child.fail = fail ? fail.next[ch] : this.root;
                if (child.fail && child.fail.output) {
                    child.output = child.output || [];
                    if (Array.isArray(child.fail.output)) {
                        child.output = [...(child.output || []), ...child.fail.output];
                    } else {
                        child.output = [...(child.output || []), child.fail.output];
                    }
                }
                queue.push(child);
            }
        }

        console.log(`✅ 构建完成 | 词数: ${words.length} | 节点: ${this.size} | 耗时: ${Date.now() - startTime}ms`);
    }

    // 单块检测（无超时）
    _containsChunk(text) {
        let node = this.root;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            while (node && !node.next[ch]) node = node.fail;
            node = node ? node.next[ch] : this.root;
            if (node && node.output) return true;
        }
        return false;
    }

    // 单块过滤
    _filterChunk(text, replaceChar = '*') {
        const result = [...text];
        const matched = new Array(text.length).fill(false);
        let node = this.root;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            while (node && !node.next[ch]) node = node.fail;
            node = node ? node.next[ch] : this.root;

            if (node && node.output) {
                const outputs = Array.isArray(node.output) ? node.output : [node.output];
                for (const word of outputs) {
                    const start = i - word.length + 1;
                    if (start >= 0) {
                        for (let j = start; j <= i; j++) matched[j] = true;
                    }
                }
            }
        }

        for (let i = 0; i < matched.length; i++) {
            if (matched[i]) result[i] = replaceChar;
        }
        return result.join('');
    }

    contains(text, timeoutMs = CONFIG.TIMEOUT_PER_CHUNK) {
        if (!text) return false;

        const startTime = Date.now();
        let node = this.root;

        for (let i = 0; i < text.length; i++) {
            if (Date.now() - startTime > timeoutMs) {
                return false;  // 超时返回 false（保守策略）
            }
            const ch = text[i];
            while (node && !node.next[ch]) node = node.fail;
            node = node ? node.next[ch] : this.root;
            if (node && node.output) return true;
        }
        return false;
    }

    filter(text, replaceChar = '*', timeoutMs = CONFIG.TIMEOUT_PER_CHUNK) {
        if (!text) return text;

        const startTime = Date.now();
        const result = [...text];
        const matched = new Array(text.length).fill(false);
        let node = this.root;

        for (let i = 0; i < text.length; i++) {
            if (Date.now() - startTime > timeoutMs) {
                return text;  // 超时返回原文
            }
            const ch = text[i];
            while (node && !node.next[ch]) node = node.fail;
            node = node ? node.next[ch] : this.root;

            if (node && node.output) {
                const outputs = Array.isArray(node.output) ? node.output : [node.output];
                for (const word of outputs) {
                    const start = i - word.length + 1;
                    if (start >= 0) {
                        for (let j = start; j <= i; j++) matched[j] = true;
                    }
                }
            }
        }

        for (let i = 0; i < matched.length; i++) {
            if (matched[i]) result[i] = replaceChar;
        }
        return result.join('');
    }
}

// ==================== 长文本分片处理器 ====================
class TextChunker {
    // 智能分片：尽量在句子边界分割
    static split(text, chunkSize = CONFIG.CHUNK_SIZE) {
        if (text.length <= chunkSize) return [text];

        const chunks = [];
        let start = 0;

        while (start < text.length) {
            let end = Math.min(start + chunkSize, text.length);

            // 如果不是最后一块，尝试在边界处分割
            if (end < text.length) {
                // 寻找最近的分割点（句号、问号、感叹号、换行、空格）
                const boundaries = ['.', '。', '?', '？', '!', '！', '\n', '\r', ' ', '，', ','];
                let bestPos = -1;

                for (let i = end; i > start; i--) {
                    if (boundaries.includes(text[i])) {
                        bestPos = i + 1;
                        break;
                    }
                }

                if (bestPos > start) {
                    end = bestPos;
                }
            }

            chunks.push(text.substring(start, end));
            start = end;
        }

        return chunks;
    }
}

// ==================== 敏感词过滤器（支持长文本）====================
class SensitiveFilter {
    static #ac = null;
    static #isReady = false;
    static #wordCount = 0;
    static #cache = new Map();

    static async load() {
        const startTime = Date.now();

        try {
            const allWords = new Set();

            if (isLSE) {
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
            SensitiveFilter.#wordCount = wordList.length;

            SensitiveFilter.#ac = new AhoCorasick();
            SensitiveFilter.#ac.build(wordList);
            SensitiveFilter.#isReady = true;

            console.log(`📚 加载完成 | 词数: ${SensitiveFilter.#wordCount} | 耗时: ${Date.now() - startTime}ms`);
            return true;

        } catch (error) {
            console.error('加载失败:', error);
            return false;
        }
    }

    // 分片检测长文本
    static contains(text) {
        if (!SensitiveFilter.#isReady || !text) return false;

        // 超长文本直接拒绝
        if (text.length > CONFIG.MAX_TEXT_LENGTH) {
            console.warn(`⚠️ 文本过长 (${text.length} > ${CONFIG.MAX_TEXT_LENGTH})，拒绝检测`);
            return true;  // 过长文本视为包含敏感词，拦截
        }

        // 检查缓存
        if (CONFIG.ENABLE_CACHE) {
            if (SensitiveFilter.#cache.has(text)) {
                return SensitiveFilter.#cache.get(text);
            }
        }

        // 分片检测
        const chunks = TextChunker.split(text, CONFIG.CHUNK_SIZE);
        let hasSensitive = false;

        for (const chunk of chunks) {
            if (SensitiveFilter.#ac._containsChunk(chunk)) {
                hasSensitive = true;
                break;
            }
        }

        // 缓存结果
        if (CONFIG.ENABLE_CACHE && SensitiveFilter.#cache.size < CONFIG.CACHE_SIZE) {
            SensitiveFilter.#cache.set(text, hasSensitive);
        }

        return hasSensitive;
    }

    // 分片过滤长文本
    static filter(text) {
        if (!SensitiveFilter.#isReady || !text) return text;

        if (text.length > CONFIG.MAX_TEXT_LENGTH) {
            return text.substring(0, CONFIG.MAX_TEXT_LENGTH) + '...(过长已截断)';
        }

        // 检查缓存
        if (CONFIG.ENABLE_CACHE) {
            const cached = SensitiveFilter.#cache.get(text);
            if (cached !== undefined && typeof cached === 'string') {
                return cached;
            }
        }

        // 分片过滤
        const chunks = TextChunker.split(text, CONFIG.CHUNK_SIZE);
        const filteredChunks = [];

        for (const chunk of chunks) {
            filteredChunks.push(SensitiveFilter.#ac._filterChunk(chunk, CONFIG.REPLACE_CHAR));
        }

        const result = filteredChunks.join('');

        // 缓存结果
        if (CONFIG.ENABLE_CACHE && SensitiveFilter.#cache.size < CONFIG.CACHE_SIZE) {
            SensitiveFilter.#cache.set(text, result);
        }

        return result;
    }

    // 获取匹配的敏感词（用于调试）
    static match(text) {
        if (!SensitiveFilter.#isReady || !text) return [];
        if (text.length > CONFIG.MAX_TEXT_LENGTH) return [];

        const matchedWords = new Set();
        const chunks = TextChunker.split(text, CONFIG.CHUNK_SIZE);

        for (const chunk of chunks) {
            let node = SensitiveFilter.#ac.root;
            for (let i = 0; i < chunk.length; i++) {
                const ch = chunk[i];
                while (node && !node.next[ch]) node = node.fail;
                node = node ? node.next[ch] : SensitiveFilter.#ac.root;
                if (node && node.output) {
                    const outputs = Array.isArray(node.output) ? node.output : [node.output];
                    outputs.forEach(w => matchedWords.add(w));
                }
            }
        }

        return [...matchedWords];
    }

    static getStatus() {
        return {
            wordCount: SensitiveFilter.#wordCount,
            cacheSize: SensitiveFilter.#cache.size,
            nodeCount: SensitiveFilter.#ac?.size || 0,
            chunkSize: CONFIG.CHUNK_SIZE,
            maxTextLength: CONFIG.MAX_TEXT_LENGTH
        };
    }
}

// ==================== LSE 环境 ====================
if (isLSE) {
    mc.listen('onServerStarted', () => {
        console.log('[敏感词过滤] 加载词库...');
        SensitiveFilter.load();
    });

    mc.listen('onChat', (player, msg) => {
        if (CONFIG.BYPASS_OP && player.isOP()) return true;

        // 超长文本直接拦截
        if (msg.length > CONFIG.MAX_TEXT_LENGTH) {
            player.tell(`§c消息过长 (${msg.length}/${CONFIG.MAX_TEXT_LENGTH})，请缩短后重试`);
            return false;
        }

        if (SensitiveFilter.contains(msg)) {
            player.tell(CONFIG.BLOCK_MESSAGE);
            return false;
        }
        return true;
    });

    ll.exports((text) => SensitiveFilter.contains(text), 'SensitiveFilter', 'contains');
    ll.exports((text) => SensitiveFilter.filter(text), 'SensitiveFilter', 'filter');
    ll.exports((text) => SensitiveFilter.match(text), 'SensitiveFilter', 'match');

    console.log('[敏感词过滤] 插件已加载 | 分片大小: ' + CONFIG.CHUNK_SIZE);
}

// ==================== Node.js 测试环境 ====================
if (isNode) {
    (async () => {
        console.log('\n🔧 敏感词过滤测试工具（支持长文本）\n');

        await SensitiveFilter.load();

        if (!SensitiveFilter.getStatus().wordCount) {
            console.log('❌ 词库加载失败');
            process.exit(1);
        }

        const status = SensitiveFilter.getStatus();
        console.log(`📊 词库: ${status.wordCount}词 | AC节点: ${status.nodeCount}`);
        console.log(`⚙️  分片大小: ${status.chunkSize}字符 | 最大长度: ${status.maxTextLength}字符\n`);

        const readline = await import('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        console.log('💡 输入文本测试，输入 "exit" 退出');
        console.log('📌 支持长文本，自动分片检测\n');

        const test = (input) => {
            if (input === 'exit') {
                console.log('\n👋 退出测试');
                rl.close();
                process.exit(0);
                return;
            }

            const memBefore = process.memoryUsage().heapUsed;
            const timeStart = Date.now();

            // 显示分片信息
            const chunks = TextChunker.split(input, CONFIG.CHUNK_SIZE);
            const chunkInfo = chunks.length > 1 ? ` (分${chunks.length}片)` : '';

            const contains = SensitiveFilter.contains(input);
            const filtered = SensitiveFilter.filter(input);
            const matched = SensitiveFilter.match(input);

            const timeEnd = Date.now();
            const memAfter = process.memoryUsage().heapUsed;

            console.log(`\n📝 输入长度: ${input.length}字符${chunkInfo}`);
            console.log(`🔍 结果: ${contains ? '⚠️ 包含敏感词' : '✅ 通过'}`);
            if (matched.length > 0) {
                console.log(`🎯 匹配词: ${matched.slice(0, 5).join(', ')}${matched.length > 5 ? ` ...等${matched.length}个` : ''}`);
            }
            if (contains && filtered !== input) {
                console.log(`✨ 过滤: ${filtered.length > 100 ? filtered.substring(0, 100) + '...' : filtered}`);
            }
            console.log(`⏱️  耗时: ${timeEnd - timeStart}ms`);
            console.log(`💾 内存: ${Math.round((memAfter - memBefore) / 1024)}KB\n`);

            ask();
        };

        const ask = () => {
            rl.question('> ', test);
        };

        ask();
    })();
}