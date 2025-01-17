class LocalizationChecker {
    checkMissingTranslation(text) {
        return text.trim() === '' || text === '#ERROR' || text === 'Loading...';
    }

    checkMultipleTranslations(text) {
        return text.match(/" or "/g);
    }

    checkGPTResponse(text) {
        const gptPatterns = [
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
            'Note: '
        ];

        const lowerText = text.toLowerCase();
        return gptPatterns.some(pattern => lowerText.includes(pattern));
    }

    checkAsianLatin(text, language) {
        if (['ja', 'zh', 'ko'].includes(language)) {
            const latinWords = text.match(/[a-zA-Z]+/g);
            if (latinWords) {
                return {
                    found: true,
                    words: latinWords
                };
            }
        }
        return { found: false };
    }

    checkSingleLatinChars(text, language) {
        const cyrillicLanguages = ['bg', 'uk'];

        if (cyrillicLanguages.includes(language)) {
            // Ищем одиночные латинские буквы, 
            // которые окружены пробелами, знаками препинания или началом/концом строки
            const latinChars = text.match(/(?:^|\s|[,.!?])[A-Za-z](?:\s|[,.!?]|$)/g);

            if (latinChars) {
                return {
                    found: true,
                    chars: latinChars.map(match => match.trim()).filter(char => char),
                };
            }
        }
        return { found: false };
    }

    checkMissingId(id) {
        return !id || id.trim() === '' || id === '#';
    }
}

// Инициализация обработчиков
document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const results = document.getElementById('results');
    const checker = new LocalizationChecker();

    let allResults = [];

    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drop-zone--over');
    });

    ['dragleave', 'dragend'].forEach(type => {
        dropZone.addEventListener(type, () => {
            dropZone.classList.remove('drop-zone--over');
        });
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drop-zone--over');

        const files = [...e.dataTransfer.files];
        handleFiles(files);
    });

    fileInput.addEventListener('change', () => {
        const files = [...fileInput.files];
        handleFiles(files);
    });

    function handleFiles(files) {
        // Очистка предыдущих результатов
        allResults = [];
        results.innerHTML = 'Обработка файлов...';

        // Создаем счетчик обработанных файлов
        let processedFiles = 0;

        files.forEach(file => {
            if (file.type === 'text/csv' || file.name.endsWith('.csv')) {
                processCsvFile(file, () => {
                    processedFiles++;
                    if (processedFiles === files.length) {
                        displayResults(allResults);
                    }
                });
            }
            else if (file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
                file.name.endsWith('.xlsx')) {
                processXlsxFile(file, () => {
                    processedFiles++;
                    if (processedFiles === files.length) {
                        displayResults(allResults);
                    }
                });
            }
            else {
                results.innerHTML = '';
                alert('Пожалуйста, загрузите файлы в формате CSV или XLSX');
            }
        });
    }

    function processCsvFile(file, callback) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const content = e.target.result;
            processCSV(content, file.name, callback);
        };
        reader.readAsText(file);
    }

    function processXlsxFile(file, callback) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            
            // Добавляем счетчик обработанных листов
            let processedSheets = 0;
            const totalSheets = workbook.SheetNames.length;
            
            // Обработка каждого листа
            workbook.SheetNames.forEach(sheetName => {
                const worksheet = workbook.Sheets[sheetName];
                const csv = XLSX.utils.sheet_to_csv(worksheet);
                
                // Обработка каждого листа с отдельным callback
                processCSV(csv, `${file.name} - ${sheetName}`, () => {
                    processedSheets++;
                    // Вызываем основной callback только после обработки всех листов
                    if (processedSheets === totalSheets) {
                        callback();
                    }
                });
            });
        };
        reader.readAsArrayBuffer(file);
    }

    function processCSV(content, fileName, callback) {
        Papa.parse(content, {
            header: true,
            skipEmptyLines: true,
            complete: function (results) {
                const headers = results.meta.fields;
                const issues = [];
                const cyrillicLanguages = ['bg', 'uk'];
                const processedIds = new Set();

                results.data.forEach((row, i) => {
                    const rowId = row[headers[0]]; // Первая колонка как ID
                    const rowIndex = i + 2; // +2 because of header and 0-based index
                    let foundChars = new Set();

                    if (checker.checkMissingId(rowId) && !processedIds.has(rowIndex)) {
                        processedIds.add(rowIndex);
                        issues.push({
                            file: fileName,
                            id: `Row ${i + 2}`, // +2 because of header and 0-based index
                            issue: 'Missing or invalid ID',
                            type: 'missing-id',
                            skipLanguage: true
                        });

                        return;
                    }
                    
                    if (!checker.checkMissingId(rowId)) {
                        headers.forEach((lang, index) => {
                            if (index === 0) return; // Пропускаем колонку ID

                            const text = row[lang] || '';
                            lang = lang.trim();

                            cyrillicLanguages.forEach(lang => {
                                const text = row[lang] || '';
                                const singleLatinCheck = checker.checkSingleLatinChars(text, lang);
                                if (singleLatinCheck.found) {
                                    singleLatinCheck.chars.forEach(char => foundChars.add(char));
                                }
                            });

                            // Если найдены непереведенные символы, добавляем одну общую ошибку для строки
                            if (foundChars.size > 0 && !processedIds.has(rowId)) {
                                processedIds.add(rowId);
                                issues.push({
                                    file: fileName,
                                    id: rowId,
                                    issue: `Untranslated characters found: ${Array.from(foundChars).join(', ')}`,
                                    type: 'untranslated'
                                });
                            }

                            if (checker.checkMissingTranslation(text)) {
                                issues.push({
                                    file: fileName,
                                    id: rowId,
                                    language: lang,
                                    issue: 'Missing translation',
                                    type: 'missing'
                                });
                            }

                            if (lang === 'en' && checker.checkGPTResponse(text)) {
                                issues.push({
                                    file: fileName,
                                    id: rowId,
                                    issue: 'GPT response detected',
                                    text: text,
                                    type: 'gpt'
                                });
                            }

                            if (lang === 'en' && checker.checkMultipleTranslations(text)) {
                                issues.push({
                                    file: fileName,
                                    id: rowId,
                                    issue: 'Multiple translations detected',
                                    text: text,
                                    type: 'multiple'
                                });
                            }

                            const asianCheck = checker.checkAsianLatin(text, lang);
                            if (asianCheck.found) {
                                issues.push({
                                    file: fileName,
                                    id: rowId,
                                    language: lang,
                                    issue: `Latin words found: ${asianCheck.words.join(', ')}`,
                                    text: text,
                                    type: 'latin'
                                });
                            }
                        });
                    };
                });

                if (issues.length === 0) {
                    allResults.push({
                        file: fileName,
                        issues: [],
                        success: true
                    });
                } else {
                    allResults.push({
                        file: fileName,
                        issues: issues,
                        success: false
                    });
                }

                callback();
            },
            error: function (error) {
                console.error(`Error parsing ${fileName}:`, error);
                callback();
            }
        });
    }

    function displayResults(results) {
        const resultsContainer = document.getElementById('results');

        resultsContainer.innerHTML = results
            .map(fileResult => {
                if (fileResult.success) {
                    return `
                        <div class="success-item">
                            <div class="file-header file-success">
                                ${fileResult.file}: Ошибок не найдено ✓
                            </div>
                        </div>
                    `;
                }

                const grouped = fileResult.issues.reduce((acc, issue) => {
                    const key = issue.id;
                    if (!acc[key]) acc[key] = [];
                    acc[key].push(issue);
                    return acc;
                }, {});

                return `
                    <div class="error-item">
                        <div class="file-header file-error">
                            ${fileResult.file}: Найдено ошибок: ${fileResult.issues.length}
                        </div>
                        ${Object.entries(grouped)
                        .map(([key, groupIssues]) => {
                            // Разделяем ошибки на missing translations и другие
                            const missingTranslations = groupIssues
                                .filter(issue => issue.type === 'missing')
                                .map(issue => issue.language);

                            const otherIssues = groupIssues
                                .filter(issue => issue.type !== 'missing');

                            return `
                                <div class="error-group">
                                    <strong>ID: ${key}</strong><br>
                                    ${missingTranslations.length > 0 ?
                                    `<div class="issue-missing">
                                        Missing translations: ${missingTranslations.join(', ')}
                                    </div>` : ''
                                }
                                    ${otherIssues.map(issue => {
                                    if (issue.skipLanguage) {
                                        return `
                                            <div class="issue-${issue.type}">
                                                ${issue.issue}
                                            </div>`;
                                    }
                                    if (issue.type === 'untranslated') {
                                        return `
                                            <div class="issue-${issue.type}">
                                                ${issue.issue}<br>
                                                <span class="check-notice">Please, check all languages for this id</span>
                                            </div>`;
                                    }
                                    if (issue.type === 'gpt' || issue.type === 'multiple') {
                                        return `
                                            <div class="issue-${issue.type}">
                                                ${issue.issue}<br>
                                                Text: ${issue.text}<br>
                                                <span class="check-notice">Please, check all languages for this id</span>
                                            </div>`;
                                    }
                                    return `
                                        <div class="issue-${issue.type}">
                                            ${issue.language}: ${issue.issue}
                                            ${issue.text ? `<br>Text: ${issue.text}` : ''}
                                        </div>`;
                                }).join('')}
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
            }).join('');
    }
});