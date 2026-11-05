import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import {
  Activity, BarChart3, Bot, ChevronDown, CircleHelp, CloudUpload, FileSpreadsheet, FileText,
  Files, LayoutDashboard, MessageSquareText, MoreHorizontal, Search, Send,
  Settings, Sparkles, Trash2, TrendingUp, Users, X
} from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
  BarChart, Bar
} from "recharts";

// Use Vite's existing /api proxy during development. This avoids CORS failures
// when Vite selects a fallback port such as 5174. Set VITE_API_URL for deployments.
const API = (import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "");

function apiErrorMessage(error, fallback = "The request could not be completed.") {
  const response = error?.response;
  const status = error?.apiStatus || response?.status;
  const serverMessage = response?.data?.error || error?.data?.error;
  if (serverMessage) return serverMessage;
  // SSE analysis failures carry the backend's already-classified message here.
  if (!response && error?.apiStatus && error?.message) return error.message;
  if (status === 504) return "Gemini timed out while analysing this file. Try a shorter PDF or ask a more focused question.";
  if (status === 429) return "Gemini is rate-limited. Please wait a moment, then try again.";
  if (status === 503) return "Gemini is temporarily unavailable due to high demand or service capacity. Please try again shortly.";
  if (status === 400 || status === 404 || status === 422) return "Gemini rejected this request. Try a shorter question or document, or check the configured model.";
  if (status === 401) return "Gemini authentication failed. Check the backend API key configuration.";
  if (status === 403) return "Gemini access is forbidden. Check the API key permissions and model access.";
  if (status === 502) return "The backend could not get a response from Gemini. Please try again shortly.";
  if (status >= 500) return `The TECHNOVALENS backend returned an error (HTTP ${status}). Check the backend terminal for details.`;
  if (!response && (error?.message === "Network Error" || error instanceof TypeError || error?.name === "AbortError")) {
    return "Cannot reach the TECHNOVALENS backend. Check that the Node.js server is running and that the Vite /api proxy is available.";
  }
  return error?.message || fallback;
}
const nav = [
  ["Dashboard", LayoutDashboard], ["Excel Files", Files], ["AI Excel Chat", MessageSquareText],
  ["Analytics", BarChart3], ["Reports", Activity]
];

export default function App() {
  const [active, setActive] = useState("Dashboard");
  const [file, setFile] = useState(null);
  const [fileInfo, setFileInfo] = useState(null);
  const [preview, setPreview] = useState([]);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([
    { role: "assistant", text: "Hi! Upload a PDF or spreadsheet and ask me questions about its content." }
  ]);
  const [documents, setDocuments] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(null);
  const [loadingWorkspace, setLoadingWorkspace] = useState(true);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [processStage, setProcessStage] = useState("");
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const inputRef = useRef(null);
  const busyRef = useRef(false);
  const openSequenceRef = useRef(0);

  const columns = useMemo(() => preview.length ? Object.keys(preview[0]) : [], [preview]);

  async function refreshPersistentLists() {
    const [filesResponse, chatsResponse] = await Promise.all([
      axios.get(`${API}/files`), axios.get(`${API}/conversations`)
    ]);
    setDocuments(filesResponse.data);
    setConversations(chatsResponse.data);
    return { files: filesResponse.data, chats: chatsResponse.data };
  }

  async function restoreConversation(conversation, options = {}) {
    if (!conversation?.id) return;
    const sequence = ++openSequenceRef.current;
    setLoadingConversation(true);
    setNotice("");
    try {
      const [chatResponse, fileResponse] = await Promise.all([
        axios.get(`${API}/conversations/${conversation.id}`),
        axios.get(`${API}/files/${conversation.fileId}`)
      ]);
      if (sequence !== openSequenceRef.current) return;
      setCurrentConversationId(chatResponse.data.id);
      setFileInfo(fileResponse.data);
      setFile(null);
      setPreview(fileResponse.data.preview || []);
      setMessages(chatResponse.data.messages.length ? chatResponse.data.messages : [
        { role: "assistant", text: `Continue asking questions about ${fileResponse.data.fileName}.` }
      ]);
      setActive(options.active || "AI Excel Chat");
      try { localStorage.setItem("technovalens.activeConversationId", chatResponse.data.id); } catch { /* Browser storage may be disabled. */ }
    } catch (error) {
      if (sequence === openSequenceRef.current) setNotice(apiErrorMessage(error, "Could not restore this conversation."));
    } finally {
      if (sequence === openSequenceRef.current) setLoadingConversation(false);
    }
  }

  async function openDocument(document) {
    try {
      let chat = conversations.find(item => item.fileId === document.fileId);
      if (!chat) {
        const created = await axios.post(`${API}/conversations`, { fileId: document.fileId, title: document.fileName });
        chat = created.data;
        await refreshPersistentLists();
      }
      await restoreConversation(chat, { active: "Excel Files" });
    } catch (error) { setNotice(apiErrorMessage(error, "Could not open this document.")); }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [filesResponse, chatsResponse] = await Promise.all([
          axios.get(`${API}/files`), axios.get(`${API}/conversations`)
        ]);
        if (cancelled) return;
        const files = filesResponse.data;
        const chats = chatsResponse.data;
        setDocuments(files); setConversations(chats);
        let selectedId = null;
        try { selectedId = localStorage.getItem("technovalens.activeConversationId"); } catch { /* Browser storage may be disabled. */ }
        const selected = chats.find(item => item.id === selectedId) || chats[0];
        if (selected) await restoreConversation(selected);
        else if (files[0]) {
          const detailResponse = await axios.get(`${API}/files/${files[0].fileId}`);
          if (!cancelled) { setFileInfo(detailResponse.data); setPreview(detailResponse.data.preview || []); setActive("Excel Files"); }
        }
      } catch (error) {
        if (!cancelled) setNotice(apiErrorMessage(error, "Could not load saved documents and conversations."));
      } finally { if (!cancelled) setLoadingWorkspace(false); }
    })();
    return () => { cancelled = true; openSequenceRef.current++; };
  }, []);

  async function uploadExcel(selected) {
    if (!selected || busyRef.current) return;
    const extension = selected.name.split(".").pop().toLowerCase();
    if (!["pdf", "xlsx", "csv"].includes(extension)) { setNotice("Choose a PDF, XLSX or CSV file."); return; }
    busyRef.current = true;
    setBusy(true); setProgress(0); setProcessStage("Uploading file"); setNotice("");
    const body = new FormData(); body.append("file", selected);
    try {
      const { data } = await axios.post(`${API}/files/upload`, body, { onUploadProgress: event => {
        const percent = event.total ? Math.round(event.loaded * 100 / event.total) : 0;
        setProgress(percent);
        if (percent >= 100) setProcessStage("Extracting text");
      } });
      setFileInfo(data); setFile(selected); setPreview(data.preview || []);
      setCurrentConversationId(data.conversationId);
      setMessages([{ role: "assistant", text: `Hi! Ask me questions about ${data.fileName}.` }]);
      try { localStorage.setItem("technovalens.activeConversationId", data.conversationId); } catch { /* Browser storage may be disabled. */ }
      await refreshPersistentLists();
      setActive("Excel Files");
      setNotice([`Successfully uploaded ${selected.name}`, data.extractionWarning].filter(Boolean).join(" "));
      setProcessStage("Completed");
    } catch (e) {
      setNotice(apiErrorMessage(e, "Upload failed. Check that the backend is running."));
      setProcessStage("");
    } finally { busyRef.current = false; setBusy(false); }
  }

  async function removeFile() {
    if (fileInfo?.fileId) {
      try { await axios.delete(`${API}/files/${fileInfo.fileId}`); }
      catch (error) { setNotice(apiErrorMessage(error, "Could not remove the uploaded file.")); return; }
    }
    setFileInfo(null); setFile(null); setPreview([]); setCurrentConversationId(null); setMessages([{ role: "assistant", text: "Upload a PDF or spreadsheet and ask me questions about its content." }]);
    try { localStorage.removeItem("technovalens.activeConversationId"); } catch { /* Browser storage may be disabled. */ }
    await refreshPersistentLists().catch(() => {});
    setNotice("Uploaded file removed.");
  }

  async function askQuestion(e, retryRequest = null) {
    e?.preventDefault();
    if (busyRef.current || loadingConversation) return;
    const q = (retryRequest?.question || question).trim();
    const requestFileId = retryRequest?.fileId || fileInfo?.fileId;
    if (!q || !requestFileId) {
      setNotice("Upload a PDF or spreadsheet before asking a question.");
      return;
    }
    if (!retryRequest) setMessages(m => [...m, { role: "user", text: q }]);
    busyRef.current = true;
    setQuestion(""); setBusy(true); setProcessStage("Analysing document"); setActive("AI Excel Chat");
    try {
      if (!currentConversationId) throw new Error("This document has no saved conversation yet. Reopen it from Your files and try again.");
      if (!retryRequest) await axios.post(`${API}/conversations/${currentConversationId}/messages`, { role: "user", text: q });
      let answer = "";
      let answerSource = "gemini";
      let answerCached = false;
      let answerRetryable = false;
      let useJsonFallback = false;
      try {
        const response = await fetch(`${API}/ai/ask/progress`, {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({ fileId: requestFileId, question: q })
        });
        if (!response.ok) {
          if ([404, 405].includes(response.status)) useJsonFallback = true;
          else {
            const data = await response.json().catch(() => ({}));
            const error = new Error(apiErrorMessage({ apiStatus: response.status, data }, "Analysis request failed."));
            error.backendFailure = true;
            throw error;
          }
        } else if (!response.body) {
          const error = new Error("The backend returned no progress stream. Please check the backend server version.");
          error.backendFailure = true;
          throw error;
        }
        else {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
            const events = buffer.split("\n\n");
            buffer = events.pop() || "";
            for (const eventText of events) {
              const eventName = eventText.match(/^event: (.+)$/m)?.[1];
              const payloadText = eventText.match(/^data: (.+)$/m)?.[1];
              if (!payloadText) continue;
              const payload = JSON.parse(payloadText);
              if (eventName === "progress") setProcessStage(payload.stage);
              if (eventName === "complete") {
                answer = payload.answer || "I couldn't produce an answer.";
                answerSource = payload.source || "gemini";
                answerCached = Boolean(payload.cached);
                answerRetryable = Boolean(payload.retryable);
              }
              if (eventName === "failure") {
                const error = new Error(payload.error);
                error.analysisFailed = true;
                error.apiStatus = payload.status;
                throw error;
              }
            }
            if (done) break;
          }
          if (!answer) useJsonFallback = true;
        }
      } catch (progressError) {
        if (progressError.analysisFailed || progressError.backendFailure) throw progressError;
        // A reset or an older backend without the SSE route must not block analysis.
        useJsonFallback = !answer;
      }
      if (useJsonFallback) {
        setProcessStage("Analysing document");
        try {
          const { data } = await axios.post(`${API}/ai/ask`, { fileId: requestFileId, question: q });
          answer = data.answer || "I couldn't produce an answer.";
          answerSource = data.source || "gemini";
          answerCached = Boolean(data.cached);
          answerRetryable = Boolean(data.retryable);
        } catch (fallbackError) {
          throw new Error(apiErrorMessage(fallbackError, "Question failed. Check your AI configuration."));
        }
      }
      setProcessStage("Completed");
      const answerMessage = { role: "assistant", text: answer || "I couldn't produce an answer.", source: answerSource, cached: answerCached, ...(answerRetryable ? { retryRequest: { fileId: requestFileId, question: q, retryCount: (retryRequest?.retryCount || 0) + (retryRequest ? 1 : 0) } } : {}) };
      setMessages(m => [...m, answerMessage]);
      await axios.post(`${API}/conversations/${currentConversationId}/messages`, answerMessage).catch(() => setNotice("Answer is shown, but could not be saved to conversation history."));
      refreshPersistentLists().catch(() => {});
    } catch (e) {
      setProcessStage("");
      setQuestion(q);
      const errorMessage = {
        role: "assistant",
        text: apiErrorMessage(e, "Question failed. Check your AI configuration."),
        retryRequest: { fileId: requestFileId, question: q, retryCount: retryRequest ? (retryRequest.retryCount || 0) + 1 : 0 }
      };
      setMessages(m => [...m, errorMessage]);
      if (currentConversationId) axios.post(`${API}/conversations/${currentConversationId}/messages`, errorMessage).catch(() => {});
    } finally { busyRef.current = false; setBusy(false); }
  }

  const stats = [
      { label: "Uploaded files", value: documents.length, icon: Files, change: "PDFs and spreadsheets" },
    { label: "Total records", value: fileInfo?.rowCount ?? (fileInfo?.pageCount ? `${fileInfo.pageCount} pages` : "—"), icon: Users, change: fileInfo?.kind === "pdf" ? "Pages detected" : "Rows detected" },
    { label: "Data columns", value: fileInfo?.columnCount ?? "—", icon: BarChart3, change: "Fields detected" },
    { label: "AI questions", value: messages.filter(x => x.role === "user").length, icon: Bot, change: "This session" }
  ];
  const chartData = [
    { name: "Mon", value: 18 }, { name: "Tue", value: 29 }, { name: "Wed", value: 23 },
    { name: "Thu", value: 38 }, { name: "Fri", value: 31 }, { name: "Sat", value: 47 }, { name: "Sun", value: 40 }
  ];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Sparkles size={21}/></div><div><b>TECHNOVA<span>LENS</span></b><small>EXCEL INTELLIGENCE</small></div></div>
      <div className="workspace-label">WORKSPACE</div>
      <nav>{nav.map(([label, Icon]) => <button key={label} className={`nav-item ${active === label ? "active" : ""}`} onClick={() => setActive(label)}><Icon size={18}/><span>{label}</span>{label === "AI Excel Chat" && <i className="new-dot"/>}</button>)}</nav>
      <div className="sidebar-conversations">
        <h4>RECENT CONVERSATIONS</h4>
        {loadingWorkspace ? <small>Loading saved chats…</small> : conversations.slice(0, 8).map(chat => (
          <button key={chat.id} className={chat.id === currentConversationId ? "selected" : ""} title={`${chat.title} · ${chat.messageCount} messages`} onClick={() => restoreConversation(chat)}>
            <MessageSquareText size={14}/><span>{chat.title || "Conversation"}</span>
          </button>
        ))}
        {!loadingWorkspace && conversations.length === 0 && <small>No saved conversations</small>}
      </div>
      <div className="sidebar-bottom">
        <button className="nav-item"><Settings size={18}/><span>Settings</span></button>
        <div className="profile"><div className="avatar">TV</div><div><b>Workspace User</b><small>Free workspace</small></div><MoreHorizontal size={18}/></div>
      </div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div className="crumb">Workspace <span>/</span> <b>{active}</b></div>
        <div className="top-actions"><button className="icon-button"><CircleHelp size={19}/></button><div className="top-avatar">TV</div></div>
      </header>
      <div className="page">
        <div className="welcome-row">
          <div><div className="eyebrow"><span className="eyebrow-dot"/> AI-POWERED DATA WORKSPACE</div><h1>{active === "Dashboard" ? "Good morning!" : active}</h1><p className="subheading">Turn your spreadsheets into clear answers and actionable insights.</p></div>
          <button className="primary-button upload-button" onClick={() => inputRef.current?.click()} disabled={busy}><CloudUpload size={18}/>{busy ? `Uploading ${progress}%` : "Upload file"}</button><input ref={inputRef} type="file" accept=".pdf,.xlsx,.csv,application/pdf" hidden onChange={e => { uploadExcel(e.target.files?.[0]); e.target.value = ""; }}/>
        </div>

        {notice && <div className="notice"><span>{notice}</span><button onClick={() => setNotice("")}><X size={15}/></button></div>}
        {loadingWorkspace && <div className="processing-status" role="status"><span className="loading-spinner"/>Loading saved documents and conversations…</div>}
        {loadingConversation && <div className="processing-status" role="status"><span className="loading-spinner"/>Restoring conversation…</div>}
        {processStage && <div className="processing-status" role="status" aria-live="polite">{busy && <span className="loading-spinner"/>}<span>{processStage}</span>{busy && progress > 0 && progress < 100 && <small>{progress}%</small>}</div>}

        {active === "AI Excel Chat" ? <section className="chat-layout">       
          <div className="chat-card">
            <div className="card-heading"><div><div className="heading-icon purple"><Bot size={19}/></div><div><h3>Ask your document</h3><p>Answers grounded in your uploaded file</p></div></div><span className="status-pill"><i/> Ready</span></div>
          <div className="chat-messages">{messages.map((m, i) => <div key={i} className={`message ${m.role}`}><div className="message-avatar">{m.role === "assistant" ? <Sparkles size={16}/> : "You"}</div><div className="bubble">{m.text}{m.source && <small className="answer-source">{{"local-pdf":"Local document engine","local-spreadsheet":"Local spreadsheet engine","gemini-primary":"Gemini primary model","gemini-fallback":"Gemini fallback model","local":"Calculated locally","gemini":"Gemini answer"}[m.source] || (m.cached ? "Cached answer" : "Analysis answer")}</small>}{m.retryRequest && (m.retryRequest.retryCount || 0) < 2 && <button className="retry-answer" disabled={busy} onClick={() => askQuestion(undefined, m.retryRequest)}>Retry with this uploaded file</button>}</div></div>)}{busy && <div className="typing">Analysing your data...</div>}</div>
            <form className="chat-input" onSubmit={askQuestion}><input value={question} onChange={e => setQuestion(e.target.value)} placeholder="Ask anything about your file..." disabled={busy || loadingConversation}/><button disabled={busy || loadingConversation}><Send size={17}/></button></form>
            <div className="suggestions"><span>Try asking:</span>{["How many rows are there?","Summarise this sheet","Show the highest value"].map(x => <button key={x} onClick={() => setQuestion(x)}>{x}</button>)}</div>
          </div>
          <div className="side-card"><h3>Current file</h3>{fileInfo ? <><div className="workbook-icon">{fileInfo.kind === "pdf" ? <FileText size={23}/> : <FileSpreadsheet size={23}/>}</div><b>{fileInfo.fileName}</b><p>{fileInfo.kind === "pdf" ? `${fileInfo.pageCount} pages` : `${fileInfo.rowCount} rows · ${fileInfo.columnCount} columns`}</p>{fileInfo.kind === "spreadsheet" && <><div className="side-divider"/><small>AVAILABLE SHEETS</small><div className="sheet-name">{fileInfo.sheetName || "Sheet 1"}</div></>}</> : <div className="empty-small">Upload a file to start chatting with its content.</div>}</div>
        </section> : active === "Excel Files" ? <section className="content-card">
          <div className="section-title"><div><h3>Your files</h3><p>Upload and preview PDF or spreadsheet content.</p></div><button className="secondary-button" onClick={() => inputRef.current?.click()}><CloudUpload size={16}/> Browse files</button></div>
          <div className={`dropzone ${dragging ? "dragging" : ""}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); uploadExcel(e.dataTransfer.files?.[0]); }}><CloudUpload size={30}/><b>Drop a file here to upload</b><p>PDF, XLSX or CSV · up to 20 MB</p><button className="primary-button" onClick={() => inputRef.current?.click()} disabled={busy}>Browse files</button>{busy && <div className="upload-progress" role="status"><span style={{ width: `${progress}%` }}/><small>{processStage} {progress > 0 ? `${progress}%` : ""}</small></div>}</div>
          <div className="saved-files"><h3>Previously uploaded files</h3>{loadingWorkspace ? <p>Loading saved files…</p> : documents.length ? documents.map(document => <div className="file-row" key={document.fileId}>
            <div className="file-symbol">{document.kind === "pdf" ? <FileText/> : <FileSpreadsheet/>}</div>
            <div className="file-meta"><b>{document.fileName}</b><small>{document.kind === "pdf" ? `${document.pageCount} pages` : `${document.rowCount} rows · ${document.columnCount} columns`} · {new Date(document.uploadedAt).toLocaleDateString()}</small></div>
            <button className="text-button" disabled={loadingConversation} onClick={() => openDocument(document)}>Open</button>
          </div>) : <p>No saved files yet.</p>}</div>
          {fileInfo && <><div className="file-row"><div className="file-symbol">{fileInfo.kind === "pdf" ? <FileText/> : <FileSpreadsheet/>}</div><div className="file-meta"><b>{fileInfo.fileName}</b><small>{fileInfo.type} · {file ? `${(file.size / 1024).toFixed(1)} KB` : "Uploaded"} · {fileInfo.kind === "pdf" ? `${fileInfo.pageCount} pages` : `${fileInfo.rowCount} rows · ${fileInfo.columnCount} columns · ${fileInfo.sheetName}`}</small></div><span className="file-status">Uploaded</span><button className="remove-file" aria-label="Remove uploaded file" title="Remove file" onClick={removeFile}><Trash2 size={17}/></button></div>{fileInfo.kind === "pdf" ? <div className="document-preview"><h4>Document preview</h4>{fileInfo.extractionWarning && <p className="extraction-warning">{fileInfo.extractionWarning}</p>}<pre>{fileInfo.preview || (fileInfo.extractionWarning ? "No selectable text was extracted from this PDF." : "")}{fileInfo.previewTruncated ? "\n\nPreview shortened. Ask AI about the full extracted document." : ""}</pre></div> : <><div className="table-wrap"><table><thead><tr>{columns.map(c => <th key={c}>{c}</th>)}</tr></thead><tbody>{preview.map((r,i)=><tr key={i}>{columns.map(c=><td key={c}>{String(r[c] ?? "")}</td>)}</tr>)}</tbody></table></div><p className="table-foot">Showing up to 10 preview rows.</p></>}</>}
        </section> : active === "Dashboard" ? <>
          <div className="stats-grid">{stats.map(({label,value,icon:Icon,change})=><div className="stat-card" key={label}><div className="stat-top"><span>{label}</span><div className="stat-icon"><Icon size={18}/></div></div><strong>{value}</strong><small>{change}</small></div>)}</div>
          <div className="dashboard-grid">
            <section className="content-card chart-card"><div className="section-title"><div><h3>Workspace activity</h3><p>Overview of recent workspace activity</p></div><button className="period-button">Last 7 days <ChevronDown size={15}/></button></div><div className="chart-area"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData}><defs><linearGradient id="purpleFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#8B5CF6" stopOpacity={0.2}/><stop offset="100%" stopColor="#8B5CF6" stopOpacity={0}/></linearGradient></defs><CartesianGrid stroke="#F0EDF7" vertical={false}/><XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill:"#9691A5",fontSize:12}}/><YAxis axisLine={false} tickLine={false} tick={{fill:"#9691A5",fontSize:12}}/><Tooltip/><Area type="monotone" dataKey="value" stroke="#8052D6" strokeWidth={2.5} fill="url(#purpleFill)"/></AreaChart></ResponsiveContainer></div></section>
            <section className="content-card quick-card"><div className="section-title"><div><h3>Quick actions</h3><p>Jump back into your workflow</p></div></div><button onClick={() => setActive("Excel Files")}><div className="quick-icon"><CloudUpload/></div><div><b>Upload a file</b><small>Add a PDF or spreadsheet</small></div><span>→</span></button><button onClick={() => setActive("AI Excel Chat")}><div className="quick-icon"><Bot/></div><div><b>Ask AI about data</b><small>Get answers in seconds</small></div><span>→</span></button><button onClick={() => setActive("Analytics")}><div className="quick-icon"><TrendingUp/></div><div><b>View analytics</b><small>Explore data insights</small></div><span>→</span></button></section>
          </div>
          <section className="content-card recent-card"><div className="section-title"><div><h3>Recent file</h3><p>Your latest uploaded document or spreadsheet</p></div><button className="text-button" onClick={() => setActive("Excel Files")}>View all</button></div>{fileInfo ? <div className="file-row"><div className="file-symbol">{fileInfo.kind === "pdf" ? <FileText/> : <FileSpreadsheet/>}</div><div className="file-meta"><b>{fileInfo.fileName}</b><small>{fileInfo.kind === "pdf" ? `${fileInfo.pageCount} pages` : `${fileInfo.rowCount} rows · ${fileInfo.columnCount} columns`}</small></div><span className="file-status">Ready</span></div> : <div className="empty-state"><div className="empty-icon"><FileText size={25}/></div><b>No files yet</b><p>Upload a PDF or spreadsheet to explore its content.</p><button className="secondary-button" onClick={() => inputRef.current?.click()}>Browse files</button></div>}</section>
        </> : <section className="content-card placeholder"><div className="empty-icon"><BarChart3 size={26}/></div><h3>{active} is coming next</h3><p>This section will be connected to your uploaded workbook in the next development phase.</p><button className="primary-button" onClick={() => setActive("Dashboard")}>Back to dashboard</button></section>}
        <footer>© 2026 TECHNOVALENS <span>Intelligent Excel. Clearer decisions.</span></footer>
      </div>
    </main>
  </div>;
}
