import React, { useState, useRef, useCallback, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";
import * as pdfjsLib from 'pdfjs-dist';

// Required for pdf.js to work in a web worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://esm.sh/pdfjs-dist@4.4.168/build/pdf.worker.mjs`;

interface KeywordResult {
  keyword: string;
  synonyms: string[];
  orbitQuery: string;
  googleQuery: string;
}

const Logo = () => (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
    <circle cx="11.5" cy="14.5" r="2.5"></circle>
    <line x1="13.2" y1="16.2" x2="15" y2="18"></line>
  </svg>
);

const ThemeToggle = ({ theme, toggleTheme }: { theme: string, toggleTheme: () => void}) => (
    <button onClick={toggleTheme} className="theme-toggle-button" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}>
        <svg className="sun" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.95-4.243-1.591 1.591M5.25 12H3m4.243-4.95L6.386 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
        </svg>
        <svg className="moon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.72 9.72 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25c0 5.385 4.365 9.75 9.75 9.75 2.833 0 5.396-1.21 7.252-3.002z" />
        </svg>
    </button>
);


const App = () => {
  const [patentText, setPatentText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<KeywordResult[]>([]);
  const [copiedKeyword, setCopiedKeyword] = useState<string | null>(null);
  const [copiedQuery, setCopiedQuery] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'cards' | 'orbit' | 'google'>('cards');
  const [theme, setTheme] = useState('light');
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (savedTheme) {
        setTheme(savedTheme);
    } else if (prefersDark) {
        setTheme('dark');
    }
  }, []);

  useEffect(() => {
    if (theme === 'dark') {
        document.body.classList.add('dark');
    } else {
        document.body.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
      setTheme(prevTheme => (prevTheme === 'light' ? 'dark' : 'light'));
  };

  /**
   * Processes a list of terms to find common stems for truncation and joins them with "OR".
   * e.g., ['programmed', 'programming', 'software'], '+' -> 'program+ OR software'
   * e.g., ['programmed', 'programming', 'software'], '*' -> 'program* OR software'
   */
  const createSearchQuery = (terms: string[], truncationChar: '+' | '*'): string => {
    const allTerms = [...new Set(terms.map(t => t.toLowerCase().trim()).filter(Boolean))];
    if (allTerms.length === 0) return "";
  
    const stems = new Map<string, Set<string>>();
    const finalTerms = new Set<string>();
    const usedTerms = new Set<string>();
    const MIN_WORD_LEN = 5;
  
    // Find potential stems
    for (const term of allTerms) {
        if (term.length < MIN_WORD_LEN) continue;
        for (let i = 1; i <= 3 && term.length - i >= 4; i++) {
            const stem = term.substring(0, term.length - i);
            if (!stems.has(stem)) {
                stems.set(stem, new Set());
            }
        }
    }
  
    // Associate terms with stems
    for (const term of allTerms) {
        for (const stem of stems.keys()) {
            if (term.startsWith(stem)) {
                stems.get(stem)!.add(term);
            }
        }
    }
  
    // Sort stems by length to process longer stems first (e.g., "program" before "pro")
    const sortedStems = Array.from(stems.keys()).sort((a, b) => b.length - a.length);
  
    // Group words under stems
    for (const stem of sortedStems) {
        const words = stems.get(stem)!;
        const unusedWordsInGroup = Array.from(words).filter(w => !usedTerms.has(w));
  
        if (unusedWordsInGroup.length > 1) {
            finalTerms.add(`${stem}${truncationChar}`);
            unusedWordsInGroup.forEach(word => usedTerms.add(word));
        }
    }
  
    // Add any remaining terms that weren't part of a stem group
    for (const term of allTerms) {
        if (!usedTerms.has(term)) {
            finalTerms.add(term);
        }
    }
  
    return Array.from(finalTerms).join(' OR ');
  };

  const clearInput = () => {
    setFileName(null);
    setPatentText('');
    setResults([]);
    setError(null);
    if (fileInputRef.current) {
        fileInputRef.current.value = '';
    }
  };

  const handleAnalyze = async () => {
    if (!patentText.trim()) {
      setError("Please provide patent text before analyzing.");
      return;
    }

    setIsLoading(true);
    setError(null);
    setResults([]);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
      const prompt = `You are an expert patent analyst specializing in prior art searches. Analyze the following patent text. Identify the most critical technical keywords and concepts. For each keyword, provide a list of relevant synonyms and related terms that would be useful for searching for prior art in databases like USPTO, Espacenet, and Google Patents. Focus on the specific domain of the patent.`;

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: `${prompt}\n\nPatent Text:\n${patentText}`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              keywords: {
                type: Type.ARRAY,
                description: "An array of key technical terms and their synonyms.",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    keyword: { type: Type.STRING, description: "A primary technical keyword or concept from the patent." },
                    synonyms: { type: Type.ARRAY, description: "A list of synonyms or related terms for the keyword, relevant for a prior art search in the patent's domain.", items: { type: Type.STRING } }
                  },
                  required: ["keyword", "synonyms"]
                }
              }
            },
            required: ["keywords"]
          },
        },
      });

      const jsonResponse = JSON.parse(response.text);
      if (jsonResponse && jsonResponse.keywords) {
        const processedResults = jsonResponse.keywords.map((res: { keyword: string; synonyms:string[] }) => ({
            ...res,
            orbitQuery: createSearchQuery([res.keyword, ...res.synonyms], '+'),
            googleQuery: createSearchQuery([res.keyword, ...res.synonyms], '*'),
        }));
        setResults(processedResults);
      } else {
        throw new Error("Invalid response structure from the API.");
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? `An error occurred: ${err.message}` : "An unknown error occurred. Please check the console.");
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleFileChange = async (file: File | null) => {
    if (!file) return;
    if (file.type !== 'application/pdf') {
        setError("Please upload a valid PDF file.");
        return;
    }
    
    clearInput();
    setIsParsing(true);
    setFileName(file.name);

    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        let fullText = '';

        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => ('str' in item ? item.str : '')).join(' ');
            fullText += pageText + '\n\n';
        }
        setPatentText(fullText.trim());

    } catch (err) {
        console.error("Error parsing PDF:", err);
        setError(err instanceof Error ? `Failed to parse PDF: ${err.message}` : "An unknown error occurred while parsing the PDF.");
        setFileName(null);
    } finally {
        setIsParsing(false);
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    handleFileChange(file || null);
    event.target.value = ''; // Reset input to allow re-uploading the same file
  };

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.classList.remove('drag-over');
    if (isLoading || isParsing || fileName) return;
    const file = event.dataTransfer.files?.[0];
    handleFileChange(file || null);
  }, [isLoading, isParsing, fileName]);

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (isLoading || isParsing || fileName) return;
    event.currentTarget.classList.add('drag-over');
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.classList.remove('drag-over');
  };

  const triggerFileSelect = () => {
    if (isLoading || isParsing || fileName) return;
    fileInputRef.current?.click();
  };

  const handleCardCopy = (result: KeywordResult) => {
    navigator.clipboard.writeText(result.synonyms.join(', ')).then(() => {
        setCopiedKeyword(result.keyword);
        setTimeout(() => setCopiedKeyword(null), 2000);
    });
  };

  const handleQueryCopy = (query: string) => {
    navigator.clipboard.writeText(query).then(() => {
        setCopiedQuery(query);
        setTimeout(() => setCopiedQuery(null), 2000);
    });
  };

  const renderResults = () => {
    if (isLoading || isParsing) {
      return (
        <div className="status-section">
          <div className="loader" aria-label="Loading"></div>
          <p>{isParsing ? "Parsing PDF, this may take a moment..." : "Analyzing text with AI..."}</p>
        </div>
      );
    }
    if (error) {
      return (
        <div className="status-section">
          <div className="error-message" role="alert">{error}</div>
        </div>
      );
    }
    if (results.length > 0) {
      return (
        <section className="results-section">
          <div className="view-switcher">
            <button className={viewMode === 'cards' ? 'active' : ''} onClick={() => setViewMode('cards')}>Keywords & Synonyms</button>
            <button className={viewMode === 'orbit' ? 'active' : ''} onClick={() => setViewMode('orbit')}>Orbit Search Queries</button>
            <button className={viewMode === 'google' ? 'active' : ''} onClick={() => setViewMode('google')}>Google Patents Queries</button>
          </div>
          <div className="results-content">
          {viewMode === 'cards' && (
            <div className="results-grid">
              {results.map((result, index) => (
                <div key={index} className="keyword-card">
                  <h3>{result.keyword}</h3>
                  <p className="synonym-list">
                    {result.synonyms.join(' / ')}
                  </p>
                  <button className={`copy-button ${copiedKeyword === result.keyword ? 'copied' : ''}`} onClick={() => handleCardCopy(result)}>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d={copiedKeyword === result.keyword ? "M4.5 12.75l6 6 9-13.5" : "M8.25 7.5H12m8.25 2.25V21M3 12.75l6.75 6.75L21 4.5M3 12.75V7.5A2.25 2.25 0 015.25 5.25h9.75a2.25 2.25 0 012.25 2.25v9.75a2.25 2.25 0 01-2.25 2.25H9"} />
                    </svg>
                    {copiedKeyword === result.keyword ? 'Copied!' : 'Copy Synonyms'}
                  </button>
                </div>
              ))}
            </div>
          )}
          {viewMode === 'orbit' && (
            <div className="orbit-dashboard">
              <div className="orbit-list">
                {results.map((result, index) => (
                  <div key={index} className="orbit-item">
                    <div className="orbit-keyword">{result.keyword}</div>
                    <div className="orbit-query-wrapper">
                      <code className="orbit-query">{result.orbitQuery}</code>
                      <button className={`copy-button-orbit ${copiedQuery === result.orbitQuery ? 'copied' : ''}`} onClick={() => handleQueryCopy(result.orbitQuery)}>
                        {copiedQuery === result.orbitQuery ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {viewMode === 'google' && (
            <div className="orbit-dashboard">
              <div className="orbit-list">
                {results.map((result, index) => (
                  <div key={index} className="orbit-item">
                    <div className="orbit-keyword">{result.keyword}</div>
                    <div className="orbit-query-wrapper">
                      <code className="orbit-query">{result.googleQuery}</code>
                      <button className={`copy-button-orbit ${copiedQuery === result.googleQuery ? 'copied' : ''}`} onClick={() => handleQueryCopy(result.googleQuery)}>
                        {copiedQuery === result.googleQuery ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          </div>
        </section>
      );
    }
    return (
        <div className="empty-state">
            <div className="empty-icon">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m5.231 13.481L15 17.25m-4.5 0-2.268-2.268c-.94-1.062-2.28-1.062-3.22 0l-1.922 1.922c-.672.672-.672 1.769 0 2.44l3.128 3.128c.672.672 1.769.672 2.44 0l1.922-1.922c.94-1.062.94-2.828 0-3.888z" /></svg>
            </div>
            <h3>Ready to Analyze</h3>
            <p>Upload a document or paste text and click "Analyze" to see your results.</p>
        </div>
    )
  }

  return (
    <div className="app-container">
      <header className="header">
        <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
        <div className="logo-container">
            <Logo />
            <h1>Patent Wordz</h1>
        </div>
        <p>Analyze patent PDFs or text to extract crucial keywords and search queries.</p>
      </header>

      <main className="input-section-wrapper">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          accept="application/pdf"
          style={{ display: 'none' }}
          disabled={isLoading || isParsing}
        />
        <div
          className={`input-area ${fileName ? 'has-file' : ''}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          {!fileName && (
             <div className="upload-prompt" onClick={triggerFileSelect} role="button" tabIndex={0} aria-label="File upload area">
                <div className="upload-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l-3.75 3.75M12 9.75l3.75 3.75M3 13.5v6c0 .621.504 1.125 1.125 1.125h16.75c.621 0 1.125-.504 1.125-1.125v-6m-19.5 0v-2.625c0-.621.504-1.125 1.125-1.125h16.75c.621 0 1.125.504 1.125-1.125V6.75C21 5.31 19.69 4.125 18.25 4.125H5.75C4.31 4.125 3 5.31 3 6.75v2.625" /></svg>
                </div>
                <p><strong>Drag & drop a PDF here</strong>, or click to select a file.</p>
            </div>
          )}
           {fileName && (
              <div className="file-info">
                  <span className="file-name-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V12.75A3.75 3.75 0 0016.5 9h-1.875a1.875 1.875 0 01-1.875-1.875V5.25A3.75 3.75 0 009 1.5H5.625zM7.5 15a.75.75 0 01.75-.75h7.5a.75.75 0 010 1.5h-7.5A.75.75 0 017.5 15zm.75 2.25a.75.75 0 000 1.5H12a.75.75 0 000-1.5H8.25z" clipRule="evenodd" /></svg>
                  </span>
                  <span className="file-name" title={fileName}>{fileName}</span>
                  <button onClick={clearInput} className="clear-file-button" aria-label="Clear file">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" /></svg>
                  </button>
              </div>
            )}
        </div>
        <textarea
          className="patent-textarea"
          value={patentText}
          onChange={(e) => {
            setPatentText(e.target.value);
            if(results.length > 0) setResults([]);
          }}
          placeholder={fileName ? "Content from PDF is loaded above." : "Or paste the full text of the patent here..."}
          disabled={isLoading || isParsing}
          readOnly={!!fileName}
          aria-label="Patent Text Input"
        />
        <div className="action-bar">
            <button
              className="analyze-button"
              onClick={handleAnalyze}
              disabled={isLoading || isParsing || !patentText.trim()}
            >
              {isLoading ? "Analyzing..." : "Analyze Patent"}
            </button>
        </div>
      </main>

      <section className="results-container">
        {renderResults()}
      </section>

    </div>
  );
};

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<App />);