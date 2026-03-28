//LiteLoaderScript Dev Helper
/// <reference path="/root/VSCode/Library/JS/index.d.ts" /> 

const isLSE = typeof mc !== 'undefined' && typeof ll !== 'undefined';
const isNode = !isLSE && typeof process !== 'undefined' && process.versions?.node;

const CONFIG = Object.freeze({
    WORD_LIST_PATH: typeof mc !== 'undefined' ? './plugins/SensitiveFilter/wordlist/' : './wordlist/',
    REPLACE_CHAR: "喵",
    ENABLE_CACHE: true,
    CACHE_SIZE: 10000,
    BYPASS_OP: true,
    BLOCK_MESSAGE: '§c消息包含敏感词，请文明发言！'
});


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

    contains(text) {
        if (!text) return false;
        let node = this.root;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            while (node && !node.next[ch]) node = node.fail;
            node = node ? node.next[ch] : this.root;
            if (node && node.output) return true;
        }
        return false;
    }

    filter(text, replaceChar = '*') {
        if (!text) return text;
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
}

// ==================== 敏感词过滤器 ====================
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
                // LSE 环境加载
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
                            .filter(w => w && !w.startsWith('#'));
                        words.forEach(w => allWords.add(w));
                    }
                }
            } else {
                // Node 环境加载
                const fs = await import('fs').then(m => m.promises);
                const path = await import('path');
                const files = await fs.readdir(CONFIG.WORD_LIST_PATH);
                const txtFiles = files.filter(f => f.endsWith('.txt'));

                for (const file of txtFiles) {
                    const content = await fs.readFile(path.join(CONFIG.WORD_LIST_PATH, file), 'utf-8');
                    const words = content.split(/\r?\n/)
                        .map(w => w.trim().toLowerCase())
                        .filter(w => w && !w.startsWith('#'));
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

    static contains(text) {
        if (!SensitiveFilter.#isReady || !text) return false;

        if (CONFIG.ENABLE_CACHE) {
            if (SensitiveFilter.#cache.has(text)) {
                return SensitiveFilter.#cache.get(text);
            }
            const result = SensitiveFilter.#ac.contains(text);
            if (SensitiveFilter.#cache.size < CONFIG.CACHE_SIZE) {
                SensitiveFilter.#cache.set(text, result);
            }
            return result;
        }

        return SensitiveFilter.#ac.contains(text);
    }

    static filter(text) {
        if (!SensitiveFilter.#isReady || !text) return text;
        return SensitiveFilter.#ac.filter(text, CONFIG.REPLACE_CHAR);
    }

    static getStatus() {
        return {
            wordCount: SensitiveFilter.#wordCount,
            cacheSize: SensitiveFilter.#cache.size,
            nodeCount: SensitiveFilter.#ac?.size || 0
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

        if (SensitiveFilter.contains(msg)) {
            player.tell(CONFIG.BLOCK_MESSAGE);
            return false;
        }
        return true;
    });

    ll.exports((text) => SensitiveFilter.contains(text), 'SensitiveFilter', 'contains');
    ll.exports((text) => SensitiveFilter.filter(text), 'SensitiveFilter', 'filter');

    console.log('[敏感词过滤] 插件已加载');
}

// ==================== Node.js 测试环境 ====================
if (isNode) {
    (async () => {
        console.log('\n🔧 敏感词过滤测试工具\n');

        await SensitiveFilter.load();

        if (!SensitiveFilter.getStatus().wordCount) {
            console.log('❌ 词库加载失败');
            process.exit(1);
        }

        const status = SensitiveFilter.getStatus();
        console.log(`📊 词库: ${status.wordCount}词 | AC节点: ${status.nodeCount} | 缓存: ${status.cacheSize}/${CONFIG.CACHE_SIZE}\n`);

        const readline = await import('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        console.log('💡 输入文本测试，输入 "exit" 退出\n');

        const test = (input) => {
            if (input === 'exit') {
                console.log('\n👋 退出测试');
                rl.close();
                process.exit(0);
                return;
            }

            const memBefore = process.memoryUsage().heapUsed;
            const timeStart = Date.now();

            const contains = SensitiveFilter.contains(input);
            const filtered = SensitiveFilter.filter(input);

            const timeEnd = Date.now();
            const memAfter = process.memoryUsage().heapUsed;

            console.log(`\n📝 输入: ${input}`);
            console.log(`🔍 结果: ${contains ? '⚠️ 包含敏感词' : '✅ 通过'}`);
            if (contains) console.log(`✨ 过滤: ${filtered}`);
            console.log(`⏱️  耗时: ${timeEnd - timeStart}ms`);
            console.log(`💾 内存: ${Math.round((memAfter - memBefore) / 1024)}KB\n`);
        };

        const ask = () => {
            rl.question('> ', test);
        };

        ask();
    })();
}