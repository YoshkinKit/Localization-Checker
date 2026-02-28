/* ── Конфигурация ── */
const CONFIG = {
    NON_LATIN_LANGUAGES: ['ja', 'zh', 'zh-hans', 'zh-hant', 'ko', 'th', 'el', 'bg', 'uk', 'ru'],
    CYRILLIC_LANGUAGES: ['bg', 'uk'],
    INVALID_VALUES: ['', '#ERROR', 'Loading...'],
    ACCEPTED_FILE_EXTENSIONS: ['.csv', '.xlsx'],
    INVALID_ID_MARKER: { '1.19': '#', '1.20': 'key' },
    SELF_CLOSING_TAGS: ['br'],
    GPT_PATTERNS: [
        'the quoted text',
        'please provide the text',
        'if there was supposed to be text',
        'appears to be missing',
        'appears to be empty',
        'is just a set of quotation marks',
        'is an exclamation mark',
        'which is a punctuation mark',
        'there is nothing to translate',
        'depending on context',
        'the text between the quotes',
        'this text contains explicit language',
        'Note: ',
    ],
};

let currentVersion = '1.20';

/* ── Класс проверок локализации ── */
class LocalizationChecker {
    isMissingTranslation(text) {
        return CONFIG.INVALID_VALUES.includes(text.trim());
    }

    hasMultipleTranslations(text) {
        return /" or "/.test(text);
    }

    isGPTResponse(text) {
        const lower = text.toLowerCase();
        return CONFIG.GPT_PATTERNS.some(p => lower.includes(p));
    }

    findLatinWords(text, language) {
        if (!CONFIG.NON_LATIN_LANGUAGES.includes(language)) return null;
        // Убираем теги перед проверкой на латиницу
        const cleanText = text.replace(/<[^>]*>/g, '');
        const words = cleanText.match(/[a-zA-Z]+/g);
        return words ?? null;
    }

    findSingleLatinChars(text, language) {
        if (!CONFIG.CYRILLIC_LANGUAGES.includes(language)) return null;
        // Одиночные латинские буквы, окружённые пробелами / пунктуацией / границами строки
        const matches = text.match(/(?:^|\s|[,.!?])[A-Za-z](?:\s|[,.!?]|$)/g);
        if (!matches) return null;
        return matches.map(m => m.trim()).filter(Boolean);
    }

    isMissingId(id, version) {
        const marker = CONFIG.INVALID_ID_MARKER[version];
        return !id || id.trim() === '' || id === marker;
    }

    isMissingTilde(id) {
        return id && !/^~/.test(id.trim());
    }

    isMissingPipe(key, text) {
        const keyPipes = (key.match(/\|/g) || []).length;
        if (keyPipes === 0) return false;
        const textPipes = (text.match(/\|/g) || []).length;
        return textPipes !== keyPipes;
    }

    findMissingTags(sourceText, translationText) {
        const tagRegex = /<\/?[a-zA-Z][^>]*>/g;
        const sourceTags = sourceText.match(tagRegex) || [];
        if (sourceTags.length === 0) return null;

        const translationTags = translationText.match(tagRegex) || [];

        const sourceCount = {};
        for (const tag of sourceTags) {
            sourceCount[tag] = (sourceCount[tag] || 0) + 1;
        }

        const transCount = {};
        for (const tag of translationTags) {
            transCount[tag] = (transCount[tag] || 0) + 1;
        }

        const missing = [];
        for (const [tag, count] of Object.entries(sourceCount)) {
            if ((transCount[tag] || 0) < count) {
                missing.push(tag);
            }
        }

        return missing.length > 0 ? missing : null;
    }

    findUnclosedTags(text) {
        const openRegex = /<([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
        const closeRegex = /<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/g;

        const openTags = [];
        let match;
        while ((match = openRegex.exec(text)) !== null) {
            const tagName = match[1].toLowerCase();
            if (!CONFIG.SELF_CLOSING_TAGS.includes(tagName)) {
                openTags.push(tagName);
            }
        }

        const closeTags = [];
        while ((match = closeRegex.exec(text)) !== null) {
            closeTags.push(match[1].toLowerCase());
        }

        const closeTagsCopy = [...closeTags];
        const unclosed = openTags.filter(tag => {
            const idx = closeTagsCopy.indexOf(tag);
            if (idx !== -1) {
                closeTagsCopy.splice(idx, 1);
                return false;
            }
            return true;
        });

        return unclosed.length > 0 ? [...new Set(unclosed)] : null;
    }
}

/* ── Утилиты чтения файлов (Promise-обёртки) ── */
function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

function parseCSV(content) {
    return new Promise((resolve, reject) => {
        Papa.parse(content, {
            header: true,
            skipEmptyLines: true,
            complete: (res) => resolve(res),
            error: (err) => reject(err),
        });
    });
}

/* ── Анализ данных ── */
function analyzeSheet(parsedData, fileName, checker, version) {
    const { meta, data } = parsedData;
    const headers = meta.fields;
    const langColumns = headers.slice(1);
    const issues = [];
    const processedIds = new Set();

    // Находим колонку с оригинальной локалью (ru) для сравнения тегов
    const sourceColumnName = langColumns.find(h => h.trim() === 'ru');

    for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const rowId = row[headers[0]];
        const rowNumber = i + 2;

        // Пропуск полностью пустых строк
        const isEmptyRow = headers.every(h => !row[h] || row[h].trim() === '');
        if (isEmptyRow) {
            issues.push({
                file: fileName,
                id: `Row ${rowNumber}`,
                issue: 'Empty row',
                type: 'empty-row',
                skipLanguage: true,
            });
            continue;
        }

        // Проверка ID
        if (checker.isMissingId(rowId, version)) {
            if (!processedIds.has(rowNumber)) {
                processedIds.add(rowNumber);
                issues.push({
                    file: fileName,
                    id: `Row ${rowNumber}`,
                    issue: 'Missing or invalid ID',
                    type: 'missing-id',
                    skipLanguage: true,
                });
            }
            continue;
        }

        // Проверка ~ в начале ключа
        if (checker.isMissingTilde(rowId)) {
            issues.push({
                file: fileName,
                id: rowId,
                issue: 'Key does not start with ~',
                type: 'missing-tilde',
                skipLanguage: true,
            });
        }

        // Проверка непереведённых одиночных латинских символов
        const foundChars = new Set();
        for (const cyrLang of CONFIG.CYRILLIC_LANGUAGES) {
            const text = row[cyrLang] || '';
            const chars = checker.findSingleLatinChars(text, cyrLang);
            if (chars) chars.forEach(c => foundChars.add(c));
        }

        if (foundChars.size > 0 && !processedIds.has(rowId)) {
            processedIds.add(rowId);
            issues.push({
                file: fileName,
                id: rowId,
                issue: `Untranslated characters found: ${[...foundChars].join(', ')}`,
                type: 'untranslated',
            });
        }

        // Получаем оригинальный текст (ru) для сравнения тегов
        const sourceText = sourceColumnName ? (row[sourceColumnName] || '') : '';

        // Проверки по каждому языку
        for (const rawLang of langColumns) {
            const lang = rawLang.trim();
            const text = row[rawLang] || '';

            if (checker.isMissingTranslation(text)) {
                issues.push({
                    file: fileName,
                    id: rowId,
                    language: lang,
                    issue: 'Missing translation',
                    type: 'missing',
                });
                continue; // Пропускаем дальнейшие проверки для пустого перевода
            }

            if (lang === 'en' && checker.isGPTResponse(text)) {
                issues.push({
                    file: fileName,
                    id: rowId,
                    issue: 'GPT response detected',
                    text,
                    type: 'gpt',
                });
            }

            if (lang === 'en' && checker.hasMultipleTranslations(text)) {
                issues.push({
                    file: fileName,
                    id: rowId,
                    issue: 'Multiple translations detected',
                    text,
                    type: 'multiple',
                });
            }

            const latinWords = checker.findLatinWords(text, lang);
            if (latinWords) {
                issues.push({
                    file: fileName,
                    id: rowId,
                    language: lang,
                    issue: `Latin words found: ${latinWords.join(', ')}`,
                    text,
                    type: 'latin',
                });
            }

            // Отсутствие | в переводе (только v1.20)
            if (version === '1.20' && checker.isMissingPipe(rowId, text)) {
                issues.push({
                    file: fileName,
                    id: rowId,
                    language: lang,
                    issue: 'Missing | separator in translation',
                    type: 'missing-pipe',
                });
            }

            // Проверка тегов относительно оригинального текста (ru)
            if (lang !== 'ru' && sourceText) {
                const missingTags = checker.findMissingTags(sourceText, text);
                if (missingTags) {
                    issues.push({
                        file: fileName,
                        id: rowId,
                        language: lang,
                        issue: `Missing tags: ${missingTags.join(', ')}`,
                        type: 'missing-tags',
                    });
                }
            }

            // Незакрытые теги (все языки)
            const unclosed = checker.findUnclosedTags(text);
            if (unclosed) {
                issues.push({
                    file: fileName,
                    id: rowId,
                    language: lang,
                    issue: `Unclosed tags: ${unclosed.map(t => '<' + t + '>').join(', ')}`,
                    type: 'unclosed-tags',
                });
            }
        }
    }

    return {
        file: fileName,
        issues,
        success: issues.length === 0,
    };
}

/* ── Обработка файлов ── */
async function processCsvFile(file, checker, version) {
    const content = await readFileAsText(file);
    const parsed = await parseCSV(content);
    return analyzeSheet(parsed, file.name, checker, version);
}

async function processXlsxFile(file, checker, version) {
    const buffer = await readFileAsArrayBuffer(file);
    const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });

    const results = [];
    for (const sheetName of workbook.SheetNames) {
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
        const parsed = await parseCSV(csv);
        results.push(analyzeSheet(parsed, `${file.name} - ${sheetName}`, checker, version));
    }
    return results;
}

function isAcceptedFile(file) {
    return CONFIG.ACCEPTED_FILE_EXTENSIONS.some(ext => file.name.endsWith(ext));
}

/* ── Отображение результатов ── */
function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderIssue(issue) {
    if (issue.skipLanguage) {
        return `<div class="issue-${issue.type}">${escapeHtml(issue.issue)}</div>`;
    }

    if (issue.type === 'untranslated') {
        return `
            <div class="issue-untranslated">
                ${escapeHtml(issue.issue)}<br>
                <span class="check-notice">Please, check all languages for this id</span>
            </div>`;
    }

    if (issue.type === 'gpt' || issue.type === 'multiple') {
        return `
            <div class="issue-${issue.type}">
                ${escapeHtml(issue.issue)}<br>
                Text: ${escapeHtml(issue.text)}<br>
                <span class="check-notice">Please, check all languages for this id</span>
            </div>`;
    }

    return `
        <div class="issue-${issue.type}">
            ${issue.language}: ${escapeHtml(issue.issue)}
            ${issue.text ? `<br>Text: ${escapeHtml(issue.text)}` : ''}
        </div>`;
}

function renderFileResult(fileResult) {
    if (fileResult.success) {
        return `
            <div class="success-item">
                <div class="file-header file-success">
                    ${fileResult.file}: Ошибок не найдено ✓
                </div>
            </div>`;
    }

    // Группировка ошибок по ID
    const grouped = {};
    for (const issue of fileResult.issues) {
        (grouped[issue.id] ??= []).push(issue);
    }

    const groupsHtml = Object.entries(grouped)
        .map(([id, groupIssues]) => {
            const missingLangs = groupIssues
                .filter(i => i.type === 'missing')
                .map(i => i.language);

            const otherIssues = groupIssues.filter(i => i.type !== 'missing');

            const missingHtml = missingLangs.length > 0
                ? `<div class="issue-missing">Missing translations: ${missingLangs.join(', ')}</div>`
                : '';

            return `
                <div class="error-group">
                    <strong>ID: ${id}</strong><br>
                    ${missingHtml}
                    ${otherIssues.map(renderIssue).join('')}
                </div>`;
        })
        .join('');

    return `
        <div class="error-item">
            <div class="file-header file-error">
                ${fileResult.file}: Найдено ошибок: ${fileResult.issues.length}
            </div>
            ${groupsHtml}
        </div>`;
}

function displayResults(results) {
    document.getElementById('results').innerHTML = results.map(renderFileResult).join('');
}

/* ── Инициализация DOM ── */
document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const resultsEl = document.getElementById('results');
    const checker = new LocalizationChecker();

    // Переключатель версии
    const versionBtns = document.querySelectorAll('.version-btn');
    const pipeErrorType = document.getElementById('errorPipe');

    versionBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            versionBtns.forEach(b => b.classList.remove('version-btn--active'));
            btn.classList.add('version-btn--active');
            currentVersion = btn.dataset.version;

            if (pipeErrorType) {
                pipeErrorType.style.display = currentVersion === '1.20' ? '' : 'none';
            }
        });
    });

    // Drag-and-drop
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drop-zone--over');
    });
    ['dragleave', 'dragend'].forEach(type =>
        dropZone.addEventListener(type, () => dropZone.classList.remove('drop-zone--over'))
    );
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drop-zone--over');
        handleFiles([...e.dataTransfer.files]);
    });
    fileInput.addEventListener('change', () => handleFiles([...fileInput.files]));

    async function handleFiles(files) {
        const validFiles = files.filter(isAcceptedFile);
        if (validFiles.length === 0) {
            alert('Пожалуйста, загрузите файлы в формате CSV или XLSX');
            return;
        }

        resultsEl.innerHTML = 'Обработка файлов...';

        try {
            const allResults = [];

            for (const file of validFiles) {
                if (file.name.endsWith('.csv')) {
                    allResults.push(await processCsvFile(file, checker, currentVersion));
                } else {
                    allResults.push(...await processXlsxFile(file, checker, currentVersion));
                }
            }

            displayResults(allResults);
        } catch (error) {
            console.error('Ошибка обработки файлов:', error);
            resultsEl.innerHTML = 'Произошла ошибка при обработке файлов.';
        }
    }
});