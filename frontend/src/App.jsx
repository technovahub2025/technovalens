import { workspaceFailureMessage } from "./workspace.js";
import { api, apiFetch } from "./api.js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, BarChart3, Bot, ChevronDown, CircleHelp, CloudUpload,
  FileSpreadsheet, FileText, Files, LayoutDashboard,
  MessageSquareText, MoreHorizontal, Send, Settings,
  Sparkles, Trash2, TrendingUp, Users, X
} from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer,
  Tooltip, XAxis, YAxis
} from "recharts";
import AnalyticsReports from "./AnalyticsReports.jsx";
import { loadConversation, initialPage } from './conversation-client.js';
import { validateFileMetadata, validateUpload, fileDimensions } from "./api-contracts.js";

// =====================================================
// API CONFIGURATION
// =====================================================

// Production: VITE_API_URL=https://your-render-service.onrender.com
// Development: Uses Vite's /api proxy.

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

// =====================================================
// SAFE ERROR HANDLING
// =====================================================

function apiErrorMessage(error, fallback = "The request could not be completed.") {
  const workspaceMessage = workspaceFailureMessage(error);
  if (workspaceMessage) return workspaceMessage;
  const response = error?.response;
  const status = error?.apiStatus || response?.status;

  const candidates = [
    response?.data?.error,
    response?.data?.message,
    error?.data?.error,
    error?.message
  ];

  let message = null;

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      message = candidate;
      break;
    }

    if (candidate && typeof candidate === "object") {
      if (typeof candidate.message === "string" && candidate.message.trim()) {
        message = candidate.message;
        break;
      }

      if (typeof candidate.error === "string" && candidate.error.trim()) {
        message = candidate.error;
        break;
      }
    }
  }

  if (status === 504) {
    return "Gemini timed out while analysing this file. Try a shorter PDF or a more focused question.";
  }

  if (status === 429) {
    if(response?.data?.code==='PARSER_BUSY')return message||'Spreadsheet processing is busy. Please retry shortly.';
    return "Gemini is rate-limited. Please wait a moment and try again.";
  }

  if (status === 503) {
    return "Gemini is temporarily unavailable. Please try again shortly.";
  }

  if ([400, 404, 422].includes(status)) {
    return message || "The backend rejected this request. Check the API route and request details.";
  }

  if (status === 403) {
    return "Backend access is forbidden. Check your API permissions.";
  }

  if (status === 502) {
    return "The backend could not get a response from Gemini.";
  }

  if (status >= 500) {
    return `TECHNOVALENS backend error (HTTP ${status}). Check Render logs.`;
  }

  if (
    !response &&
    (
      error?.message === "Network Error" ||
      error instanceof TypeError ||
      error?.name === "AbortError"
    )
  ) {
    return "Cannot reach the TECHNOVALENS backend. Check your Render service and API URL.";
  }

  return message || fallback;
}

// Ensure anything displayed inside React is safe text.
function safeText(value, fallback = "") {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value && typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
  }

  return fallback;
}

// =====================================================
// NAVIGATION
// =====================================================

const nav = [
  ["Dashboard", LayoutDashboard],
  ["Excel Files", Files],
  ["AI Excel Chat", MessageSquareText],
  ["Reports", Activity]
];

// =====================================================
// MAIN APP
// =====================================================

export default function App() {
  const [active, setActive] = useState(()=>initialPage(window.location));
  useEffect(()=>{
    const routes={'Dashboard':'dashboard','Excel Files':'files','AI Excel Chat':'chat','Reports':'reports'};
    if(routes[active])window.history.replaceState(null,'',`${window.location.pathname}${window.location.search}#${routes[active]}`);
  },[active]);
  useEffect(()=>{const navigate=()=>{
    const page=initialPage(window.location);
    if(page==='Reports'&&/^#\/?analytics\/?$/i.test(window.location.hash))window.history.replaceState(null,'',`${window.location.pathname}${window.location.search}#reports`);
    setActive(page);
  };window.addEventListener('hashchange',navigate);return()=>window.removeEventListener('hashchange',navigate);},[]);

  const [file, setFile] = useState(null);
  const [fileInfo, setFileInfo] = useState(null);
  const [chatWorksheets,setChatWorksheets]=useState(()=>{try{const stored=JSON.parse(localStorage.getItem('technovalens.chatWorksheets')||'{}');return stored&&typeof stored==='object'&&!Array.isArray(stored)?stored:{};}catch{return {};}});
  const savedSheet=fileInfo&&Object.prototype.hasOwnProperty.call(chatWorksheets,fileInfo.fileId)?chatWorksheets[fileInfo.fileId]:fileInfo?.sheetName;
  const selectedSheet=fileInfo?.kind==='spreadsheet'&&fileInfo.sheetNames?.includes(savedSheet)?savedSheet:null;
  function selectChatWorksheet(name){
    setChatWorksheets(previous=>{const next={...previous,[fileInfo.fileId]:name||null};try{localStorage.setItem('technovalens.chatWorksheets',JSON.stringify(next));}catch{}return next;});
  }
  const [preview, setPreview] = useState([]);

  const [question, setQuestion] = useState("");

  const [messages, setMessages] = useState([
    {
      role: "assistant",
      text: "Hi! Upload a PDF or spreadsheet and ask me questions about its content."
    }
  ]);

  const [documents, setDocuments] = useState([]);
  const [selectedWorkbookId, setSelectedWorkbookId] = useState(() => {
    try { return localStorage.getItem("technovalens.selectedWorkbookId") || ""; } catch { return ""; }
  });
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
  const uploadControllerRef = useRef(null);
  const chatControllerRef = useRef(null);
  const openSequenceRef = useRef(0);

  const columns = useMemo(
    () => preview.length && preview[0] && typeof preview[0] === "object"
      ? Object.keys(preview[0])
      : [],
    [preview]
  );

  // =====================================================
  // LOAD SAVED FILES AND CONVERSATIONS
  // =====================================================

  async function refreshPersistentLists() {
    const [filesResponse, chatsResponse] = await Promise.all([
      api.get(`/files`),
      api.get(`/conversations`)
    ]);

    const files = Array.isArray(filesResponse.data)
      ? filesResponse.data
      : [];

    const chats = Array.isArray(chatsResponse.data)
      ? chatsResponse.data
      : [];

    files.forEach(validateFileMetadata);
    setDocuments(files);
    setConversations(chats);

    return { files, chats };
  }

  // =====================================================
  // RESTORE CONVERSATION
  // =====================================================

  async function restoreConversation(conversation, options = {}) {
    if (!conversation?.id) return;
    if(uploadControllerRef.current){setNotice('Finish or cancel the upload before switching conversations.');return;}

    const sequence = ++openSequenceRef.current;
    chatControllerRef.current?.abort();
    busyRef.current=false;setBusy(false);setProcessStage('');
    setCurrentConversationId(null);setFileInfo(null);setPreview([]);setMessages([]);setFile(null);setQuestion('');
    setLoadingConversation(true);
    setNotice("");
    setActive(options.active || 'AI Excel Chat');

    try {
      const {chat,document,recoveryMessage}=await loadConversation(api,conversation.id);

      if (sequence !== openSequenceRef.current) return;

      setCurrentConversationId(chat.id);
      setFileInfo(document);
      setFile(null);
      setPreview(Array.isArray(document?.preview) ? document.preview : []);
      if(recoveryMessage)setNotice(recoveryMessage);

      const restoredMessages = Array.isArray(chat.messages)
        ? chat.messages.map(message => ({
            ...message,
            text: safeText(message.text, "")
          }))
        : [];

      setMessages(restoredMessages);

      setActive(options.active || "AI Excel Chat");

      try {
        localStorage.setItem(
          "technovalens.activeConversationId",
          chat.id
        );
      } catch {
        // Browser storage may be disabled.
      }

    } catch (error) {
      if (sequence === openSequenceRef.current) {
        setNotice(
          apiErrorMessage(error, "Could not restore this conversation.")
        );
      }
    } finally {
      if (sequence === openSequenceRef.current) {
        setLoadingConversation(false);
      }
    }
  }

  // =====================================================
  // OPEN DOCUMENT
  // =====================================================

  async function openDocument(document) {
    try {
      let chat = conversations.find(
        item => item.fileId === document.fileId
      );

      if (!chat) {
        const created = await api.post(`/conversations`, {
          fileId: document.fileId,
          title: document.fileName
        });

        chat = created.data;

        await refreshPersistentLists();
      }

      await restoreConversation(chat, {
        active: "Excel Files"
      });

    } catch (error) {
      setNotice(
        apiErrorMessage(error, "Could not open this document.")
      );
    }
  }

  // =====================================================
  // INITIAL WORKSPACE LOADING
  // =====================================================

  useEffect(() => {
    let cancelled = false;

    async function initializeWorkspace() {
      try {
        const [filesResponse, chatsResponse] = await Promise.all([
          api.get(`/files`),
          api.get(`/conversations`)
        ]);

        if (cancelled) return;

        const files = Array.isArray(filesResponse.data)
          ? filesResponse.data
          : [];

        const chats = Array.isArray(chatsResponse.data)
          ? chatsResponse.data
          : [];

        setDocuments(files);
        setConversations(chats);

        let selectedId = null;

        try {
          selectedId = localStorage.getItem(
            "technovalens.activeConversationId"
          );
        } catch {
          // Browser storage may be disabled.
        }

        if(selectedId)await restoreConversation({id:selectedId},{active:initialPage(window.location)});

      } catch (error) {
        if (!cancelled) {
          setNotice(
            apiErrorMessage(
              error,
              "Could not load saved documents and conversations."
            )
          );
        }
      } finally {
        if (!cancelled) {
          setLoadingWorkspace(false);
        }
      }
    }

    initializeWorkspace();

    return () => {
      cancelled = true;
      chatControllerRef.current?.abort();
      openSequenceRef.current++;
    };
  }, []);

  // =====================================================
  // FILE UPLOAD
  // =====================================================

  async function uploadExcel(selected) {
    if (!selected || busyRef.current) return;

    const extension = selected.name.split(".").pop().toLowerCase();

    if (!["pdf", "xlsx", "csv"].includes(extension)) {
      setNotice("Choose a PDF, XLSX or CSV file.");
      return;
    }

    if (selected.size > MAX_UPLOAD_SIZE) {
      setNotice("File exceeds the 50 MB upload limit. Choose a smaller PDF, XLSX or CSV file.");
      return;
    }

    busyRef.current = true;

    setBusy(true);
    setProgress(0);
    setProcessStage("Uploading file");
    setNotice("");

    const body = new FormData();
    body.append("file", selected);
    const job=crypto.randomUUID();
    const uploadController=new AbortController();uploadController.jobId=job;uploadControllerRef.current=uploadController;
    let progressPoll,progressActive=true;

    try {
      if(extension!=='pdf')progressPoll=setInterval(async()=>{
        if(!progressActive)return;
        try{
          const {data}=await api.get(`/files/upload-status/${job}`,{signal:uploadController.signal});
          if(!progressActive)return;
          const index=data.worksheetIndex||0,count=data.worksheetCount||0;
          if(data.stage==='worksheets-discovered')setProcessStage(`Discovered ${count} worksheets`);
          if(data.stage==='worksheet-processing'||data.stage==='worksheet-parsed'||data.stage==='worksheet-loading')setProcessStage(`Processing worksheet ${index} of ${count}`);
          if(data.stage==='worksheet-storage')setProcessStage(`Saving worksheet ${index} of ${count}`);
          if(data.stage==='worksheet-analysis'||data.stage==='worksheet-analyzed')setProcessStage(`Analyzing worksheet ${index} of ${count}`);
          if(data.stage==='finalizing')setProcessStage('Saving analysis');
        }catch{/* Progress can begin after the multipart body reaches the backend. */}
      },500);
      const { data } = await api.post(
        `/files/upload`,
        body,
        {
          params:{job},signal:uploadController.signal,
          timeout:0, // The bounded backend worker deadline owns processing timeouts.
          onUploadProgress: event => {
            const percent = event.total
              ? Math.round(event.loaded * 100 / event.total)
              : 0;

            setProgress(percent);

            if (percent >= 100) {
              setProcessStage(extension==='pdf'?"Extracting text":"Discovering worksheets");
            }
          }
        }
      );

      validateUpload(data);
      setFileInfo(data);
      setFile(selected);
      if (data.kind === "spreadsheet") {
        setSelectedWorkbookId(data.fileId);
        try { localStorage.setItem("technovalens.selectedWorkbookId", data.fileId); } catch { /* Storage may be disabled. */ }
      }

      setPreview(
        Array.isArray(data.preview) ? data.preview : []
      );

      setCurrentConversationId(data.conversationId);

      setMessages([
        {
          role: "assistant",
          text: `Hi! Ask me questions about ${safeText(data.fileName, "your file")}.`
        }
      ]);

      try {
        localStorage.setItem(
          "technovalens.activeConversationId",
          data.conversationId
        );
      } catch {
        // Browser storage may be disabled.
      }

      await refreshPersistentLists();

      setActive("Excel Files");

      setNotice(
        [
          `Successfully uploaded ${selected.name}`,
          data.extractionWarning
        ]
          .filter(Boolean)
          .map(value => safeText(value))
          .join(" ")
      );

      setProcessStage("Completed");

    } catch (error) {
      setNotice(
        error.code==='ERR_CANCELED'?'Upload cancelled.':apiErrorMessage(
          error,
          "Upload failed. Check the backend connection."
        )
      );

      setProcessStage("");

    } finally {
      progressActive=false;clearInterval(progressPoll);uploadController.abort();uploadControllerRef.current=null;
      busyRef.current = false;
      setBusy(false);
    }
  }

  // =====================================================
  // REMOVE FILE
  // =====================================================

  async function removeFile() {
    if (fileInfo?.fileId) {
      try {
        await api.delete(
          `/files/${fileInfo.fileId}`
        );
      } catch (error) {
        setNotice(
          apiErrorMessage(error, "Could not remove the uploaded file.")
        );
        return;
      }
    }

    setFileInfo(null);
    setFile(null);
    setPreview([]);
    setCurrentConversationId(null);

    setMessages([
      {
        role: "assistant",
        text: "Upload a PDF or spreadsheet and ask me questions about its content."
      }
    ]);

    try {
      localStorage.removeItem(
        "technovalens.activeConversationId"
      );
    } catch {
      // Browser storage may be disabled.
    }

    await refreshPersistentLists().catch(() => {});

    setNotice("Uploaded file removed.");
  }

  // =====================================================
  // AI QUESTION AND ANSWER
  // =====================================================

  async function askQuestion(e, retryRequest = null) {
    e?.preventDefault();

    if (busyRef.current || loadingConversation) return;

    const q = (
      retryRequest?.question || question
    ).trim();

    const requestFileId =
      retryRequest?.fileId || fileInfo?.fileId;

    if (!q || !requestFileId) {
      setNotice(
        "Upload a PDF or spreadsheet before asking a question."
      );
      return;
    }
    if(requestFileId!==fileInfo?.fileId||!currentConversationId){setNotice('Reopen the original conversation before retrying this question.');return;}
    const requestConversationId=currentConversationId,requestSequence=openSequenceRef.current;
    const requestSelectedSheet=retryRequest?(retryRequest.selectedSheet??null):selectedSheet;
    const controller=new AbortController();chatControllerRef.current=controller;
    const stillSelected=()=>openSequenceRef.current===requestSequence&&!controller.signal.aborted;

    if (!retryRequest) {
      setMessages(current => [
        ...current,
        { role: "user", text: q }
      ]);
    }

    busyRef.current = true;

    setQuestion("");
    setBusy(true);
    setProcessStage("Analysing document");
    setActive("AI Excel Chat");

    try {
      if (!currentConversationId) {
        throw new Error(
          "This document has no saved conversation yet. Reopen it from Your files and try again."
        );
      }

      if (!retryRequest) {
        await api.post(
          `/conversations/${requestConversationId}/messages`,
          {
            role: "user",
            text: q,fileId:requestFileId
          },{signal:controller.signal}
        );
      }

      let answer = "";
      let answerSource = "gemini";
      let answerCached = false;
      let answerRetryable = false;
      let useJsonFallback = false;

      // -----------------------------------------------
      // PROGRESS STREAM
      // -----------------------------------------------

      try {
        const response = await apiFetch(
          `/ai/ask/progress`,
          {
            method: "POST",
            signal:controller.signal,
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream"
            },
            body: JSON.stringify({
              fileId: requestFileId,
              conversationId:requestConversationId,
              selectedSheet:requestSelectedSheet,
              question: q
            })
          }
        );

        if (!response.ok) {
          if ([404, 405].includes(response.status)) {
            useJsonFallback = true;
          } else {
            const data = await response.json().catch(() => ({}));

            const error = new Error(
              apiErrorMessage(
                {
                  apiStatus: response.status,
                  data
                },
                "Analysis request failed."
              )
            );

            error.backendFailure = true;
            throw error;
          }

        } else if (!response.body) {
          const error = new Error(
            "The backend returned no progress stream. Check the backend server version."
          );

          error.backendFailure = true;
          throw error;

        } else {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();

          let buffer = "";

          while (true) {
            const { value, done } = await reader.read();

            buffer += decoder.decode(
              value || new Uint8Array(),
              { stream: !done }
            );

            const events = buffer.split("\n\n");
            buffer = events.pop() || "";

            for (const eventText of events) {
              const eventName =
                eventText.match(/^event: (.+)$/m)?.[1];

              const payloadText =
                eventText.match(/^data: (.+)$/m)?.[1];

              if (!payloadText) continue;

              const payload = JSON.parse(payloadText);

              if (eventName === "progress" && stillSelected()) {
                setProcessStage(
                  safeText(payload.stage, "Analysing document")
                );
              }

              if (eventName === "complete") {
                answer = safeText(
                  payload.answer,
                  "I couldn't produce an answer."
                );

                answerSource = safeText(
                  payload.source,
                  "gemini"
                );

                answerCached = Boolean(payload.cached);
                answerRetryable = Boolean(payload.retryable);
              }

              if (eventName === "failure") {
                const error = new Error(
                  safeText(
                    payload.error,
                    "Document analysis failed."
                  )
                );

                error.analysisFailed = true;
                error.apiStatus = payload.status;

                throw error;
              }
            }

            if (done) break;
          }

          if (!answer) {
            useJsonFallback = true;
          }
        }

      } catch (progressError) {
        if(!stillSelected())return;
        if (
          progressError.analysisFailed ||
          progressError.backendFailure
        ) {
          throw progressError;
        }

        // Older backend or interrupted SSE connection.
        useJsonFallback = !answer;
      }

      // -----------------------------------------------
      // JSON FALLBACK
      // -----------------------------------------------

      if (useJsonFallback) {
        if(!stillSelected())return;
        setProcessStage("Analysing document");

        try {
          const { data } = await api.post(
            `/ai/ask`,
            {
              fileId: requestFileId,
              conversationId:requestConversationId,
              selectedSheet:requestSelectedSheet,
              question: q
            },{signal:controller.signal}
          );

          answer = safeText(
            data.answer,
            "I couldn't produce an answer."
          );

          answerSource = safeText(
            data.source,
            "gemini"
          );

          answerCached = Boolean(data.cached);
          answerRetryable = Boolean(data.retryable);

        } catch (fallbackError) {
          throw new Error(
            apiErrorMessage(
              fallbackError,
              "Question failed. Check your AI configuration."
            )
          );
        }
      }

      // -----------------------------------------------
      // SAVE ANSWER
      // -----------------------------------------------

      if(!stillSelected())return;
      setProcessStage("Completed");

      const answerMessage = {
        role: "assistant",
        fileId:requestFileId,
        text: safeText(answer, "I couldn't produce an answer."),
        source: answerSource,
        cached: answerCached,

        ...(answerRetryable
          ? {
              retryRequest: {
                fileId: requestFileId,
                selectedSheet:requestSelectedSheet,
                question: q,
                retryCount:
                  (retryRequest?.retryCount || 0) +
                  (retryRequest ? 1 : 0)
              }
            }
          : {})
      };

      setMessages(current => [
        ...current,
        answerMessage
      ]);

      await api.post(
        `/conversations/${requestConversationId}/messages`,
        answerMessage,{signal:controller.signal}
      ).catch(() => {
        if(stillSelected())setNotice(
          "Answer is shown, but could not be saved to conversation history."
        );
      });

      refreshPersistentLists().catch(() => {});

    } catch (error) {
      if(!stillSelected())return;
      setProcessStage("");
      setQuestion(q);

      const errorMessage = {
        role: "assistant",
        text: apiErrorMessage(
          error,
          "Question failed. Check your AI configuration."
        ),

        retryRequest: {
          fileId: requestFileId,
          selectedSheet:requestSelectedSheet,
          question: q,
          retryCount: retryRequest
            ? (retryRequest.retryCount || 0) + 1
            : 0
        }
      };

      setMessages(current => [
        ...current,
        errorMessage
      ]);

      if (currentConversationId) {
        api.post(
          `/conversations/${requestConversationId}/messages`,
          {...errorMessage,fileId:requestFileId}
        ).catch(() => {});
      }

    } finally {
      if(openSequenceRef.current===requestSequence){busyRef.current=false;setBusy(false);}
      if(chatControllerRef.current===controller)chatControllerRef.current=null;
    }
  }

  // =====================================================
  // DASHBOARD STATISTICS
  // =====================================================

  const stats = [
    {
      label: "Uploaded files",
      value: documents.length,
      icon: Files,
      change: "PDFs and spreadsheets"
    },
    {
      label: "Total records",
      value:
        fileInfo?.totalRowCount ?? fileInfo?.rowCount ??
        (fileInfo?.pageCount
          ? `${fileInfo.pageCount} pages`
          : "—"),
      icon: Users,
      change:
        fileInfo?.kind === "pdf"
          ? "Pages detected"
          : "Rows detected"
    },
    {
      label: "Data columns",
      value: fileInfo?.columnCount ?? "—",
      icon: BarChart3,
      change: "Fields detected"
    },
    {
      label: "AI questions",
      value: messages.filter(x => x.role === "user").length,
      icon: Bot,
      change: "This session"
    }
  ];

  const chartData = [
    { name: "Mon", value: 18 },
    { name: "Tue", value: 29 },
    { name: "Wed", value: 23 },
    { name: "Thu", value: 38 },
    { name: "Fri", value: 31 },
    { name: "Sat", value: 47 },
    { name: "Sun", value: 40 }
  ];

  // =====================================================
  // SOURCE LABELS
  // =====================================================

  const sourceLabels = {
    "local-pdf": "Local document engine",
    "local-spreadsheet": "Local spreadsheet engine",
    "gemini-primary": "Gemini primary model",
    "gemini-fallback": "Gemini fallback model",
    local: "Calculated locally",
    gemini: "Gemini answer"
  };

  // =====================================================
  // USER INTERFACE
  // =====================================================

  return (
    <div className="app-shell">

      {/* SIDEBAR */}

      <aside className="sidebar">

        <div className="brand">
          <div className="brand-mark">
            <Sparkles size={21} />
          </div>

          <div>
            <b>
              TECHNOVA<span>LENS</span>
            </b>
            <small>EXCEL INTELLIGENCE</small>
          </div>
        </div>

        <div className="workspace-label">
          WORKSPACE
        </div>

        <nav>
          {nav.map(([label, Icon]) => (
            <button
              key={label}
              className={`nav-item ${
                active === label ? "active" : ""
              }`}
              onClick={() => setActive(label)}
              aria-label={label}
            >
              <Icon size={18} />
              <span>{label}</span>

              {label === "AI Excel Chat" && (
                <i className="new-dot" />
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-conversations">
          <h4>RECENT CONVERSATIONS</h4>

          {loadingWorkspace ? (
            <small>Loading saved chats…</small>
          ) : (
            conversations.slice(0, 8).map(chat => (
              <button
                key={chat.id}
                className={
                  chat.id === currentConversationId
                    ? "selected"
                    : ""
                }
                title={`${safeText(chat.title, "Conversation")} · ${chat.messageCount || 0} messages`}
                onClick={() => restoreConversation(chat)}
              >
                <MessageSquareText size={14} />
                <span>
                  {safeText(chat.title, "Conversation")}
                </span>
              </button>
            ))
          )}

          {!loadingWorkspace &&
            conversations.length === 0 && (
              <small>No saved conversations</small>
            )}
        </div>

        <div className="sidebar-bottom">

          <button className="nav-item">
            <Settings size={18} />
            <span>Settings</span>
          </button>

          <div className="profile">
            <div className="avatar">TV</div>

            <div>
              <b>Workspace User</b>
              <small>Free workspace</small>
            </div>

            <MoreHorizontal size={18} />
          </div>

        </div>
      </aside>

      {/* MAIN CONTENT */}

      <main className="main">

        <header className="topbar">
          <div className="crumb">
            Workspace <span>/</span> <b>{active}</b>
          </div>

          <div className="top-actions">
            <button className="icon-button">
              <CircleHelp size={19} />
            </button>

            <div className="top-avatar">TV</div>
          </div>
        </header>

        <div className="page">
          <label className="mobile-conversations">Conversation
            <select aria-label="Saved conversation" value={currentConversationId||''} disabled={loadingConversation||Boolean(uploadControllerRef.current)} onChange={event=>{if(event.target.value)restoreConversation({id:event.target.value});}}>
              <option value="">Choose saved conversation</option>
              {conversations.map(chat=><option key={chat.id} value={chat.id}>{safeText(chat.title,'Conversation')}</option>)}
            </select>
          </label>

          {/* WELCOME */}

          <div className="welcome-row">

            <div>
              <div className="eyebrow">
                <span className="eyebrow-dot" />
                AI-POWERED DATA WORKSPACE
              </div>

              <h1>
                {active === "Dashboard"
                  ? "Good morning!"
                  : active}
              </h1>

              <p className="subheading">
                Turn your spreadsheets into clear answers
                and actionable insights.
              </p>
            </div>

            <button
              className="primary-button upload-button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              <CloudUpload size={18} />

              {busy
                ? `Uploading ${progress}%`
                : "Upload file"}
            </button>

            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.xlsx,.csv,application/pdf"
              hidden
              onChange={e => {
                uploadExcel(e.target.files?.[0]);
                e.target.value = "";
              }}
            />

          </div>

          {/* NOTIFICATIONS */}

          {notice && (
            <div className="notice">
              <span>{safeText(notice)}</span>

              <button onClick={() => setNotice("")}>
                <X size={15} />
              </button>
            </div>
          )}

          {loadingWorkspace && (
            <div className="processing-status" role="status">
              <span className="loading-spinner" />
              Loading saved documents and conversations…
            </div>
          )}

          {loadingConversation && (
            <div className="processing-status" role="status">
              <span className="loading-spinner" />
              Restoring conversation…
            </div>
          )}

          {processStage && (
            <div
              className="processing-status"
              role="status"
              aria-live="polite"
            >
              {busy && <span className="loading-spinner" />}

              <span>{safeText(processStage)}</span>

              {busy && progress > 0 && progress < 100 && (
                <small>{progress}%</small>
              )}
            </div>
          )}

          {/* ================================================= */}
          {/* AI CHAT */}
          {/* ================================================= */}

          {active === "AI Excel Chat" ? (

            <section className="chat-layout">

              <div className="chat-card">

                <div className="card-heading">

                  <div>
                    <div className="heading-icon purple">
                      <Bot size={19} />
                    </div>

                    <div>
                      <h3>Ask your document</h3>
                      <p>
                        Answers grounded in your uploaded file
                      </p>
                    </div>
                  </div>

                  <span className="status-pill">
                    <i /> {fileInfo ? "Ready" : "Upload a file"}
                  </span>

                </div>

                <div className="chat-messages">

                  {messages.map((m, i) => (
                    <div
                      key={i}
                      className={`message ${m.role}`}
                    >

                      <div className="message-avatar">
                        {m.role === "assistant"
                          ? <Sparkles size={16} />
                          : "You"}
                      </div>

                      <div className="bubble">

                        {safeText(m.text)}

                        {m.source && (
                          <small className="answer-source">
                            {sourceLabels[m.source] ||
                              (m.cached
                                ? "Cached answer"
                                : "Analysis answer")}
                          </small>
                        )}

                        {m.retryRequest &&
                          (m.retryRequest.retryCount || 0) < 2 && (
                            <button
                              className="retry-answer"
                              disabled={busy}
                              onClick={() =>
                                askQuestion(
                                  undefined,
                                  m.retryRequest
                                )
                              }
                            >
                              Retry with this uploaded file
                            </button>
                          )}

                      </div>
                    </div>
                  ))}

                  {busy && (
                    <div className="typing">
                      Analysing your data...
                    </div>
                  )}

                </div>

                <form
                  className="chat-input"
                  onSubmit={askQuestion}
                >
                  <input
                    value={question}
                    onChange={e => setQuestion(e.target.value)}
                    placeholder="Ask anything about your file..."
                    disabled={busy || loadingConversation || !fileInfo || !currentConversationId}
                  />

                  <button
                    disabled={busy || loadingConversation || !fileInfo || !currentConversationId}
                  >
                    <Send size={17} />
                  </button>
                </form>

                <div className="suggestions">
                  <span>Try asking:</span>

                  {[
                    "How many rows are there?",
                    "Summarise this sheet",
                    "Show the highest value"
                  ].map(x => (
                    <button
                      key={x}
                      onClick={() => setQuestion(x)}
                    >
                      {x}
                    </button>
                  ))}
                </div>

              </div>

              {/* CURRENT FILE */}

              <div className="side-card">

                <h3>Current file</h3>

                {fileInfo ? (

                  <>
                    <div className="workbook-icon">
                      {fileInfo.kind === "pdf"
                        ? <FileText size={23} />
                        : <FileSpreadsheet size={23} />}
                    </div>

                    <b>{safeText(fileInfo.fileName)}</b>

                    <p>
                      {fileDimensions(fileInfo)}
                    </p>

                    {fileInfo.kind === "spreadsheet" && (
                      <>
                        <div className="side-divider" />

                        <label className="chat-worksheet">Selected worksheet
                          <select aria-label="Chat worksheet" value={selectedSheet||''} disabled={busy||loadingConversation} onChange={event=>selectChatWorksheet(event.target.value)}>
                            <option value="">Choose a worksheet</option>
                            {(fileInfo.sheetNames||[]).map(name=><option key={name} value={name}>{name}</option>)}
                          </select>
                        </label>
                      </>
                    )}

                  </>

                ) : (

                  <div className="empty-small">
                    Upload a file to start chatting with its content.
                  </div>

                )}

              </div>

            </section>

          ) : active === "Excel Files" ? (

            /* ================================================= */
            /* FILES PAGE */
            /* ================================================= */

            <section className="content-card">

              <div className="section-title">

                <div>
                  <h3>Your files</h3>
                  <p>
                    Upload and preview PDF or spreadsheet content.
                  </p>
                </div>

                <button
                  className="secondary-button"
                  onClick={() => inputRef.current?.click()}
                >
                  <CloudUpload size={16} />
                  Browse files
                </button>

              </div>

              <div
                className={`dropzone ${
                  dragging ? "dragging" : ""
                }`}
                onDragOver={e => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => {
                  e.preventDefault();
                  setDragging(false);
                  uploadExcel(e.dataTransfer.files?.[0]);
                }}
              >

                <CloudUpload size={30} />

                <b>Drop a file here to upload</b>

                <p>PDF, XLSX or CSV · up to 50 MB</p>

                <button
                  type="button"
                  className="primary-button"
                  onClick={() => inputRef.current?.click()}
                  disabled={busy}
                >
                  Browse files
                </button>

                {busy && (
                  <div
                    className="upload-progress"
                    role="status"
                  >
                    <span
                      style={{ width: `${progress}%` }}
                    />

                    <small>
                      {safeText(processStage)}{" "}
                      {processStage==='Uploading file' && progress > 0 ? `${progress}%` : ""}
                    </small>
                  </div>
                )}
                {busy && uploadControllerRef.current && <button type="button" className="secondary-button" onClick={()=>{const controller=uploadControllerRef.current;if(!controller)return;api.delete(`/files/upload-status/${controller.jobId}`).catch(()=>{});controller.abort();}}>Cancel upload</button>}

              </div>

              {/* SAVED FILES */}

              <div className="saved-files">

                <h3>Previously uploaded files</h3>

                {loadingWorkspace ? (

                  <p>Loading saved files…</p>

                ) : documents.length ? (

                  documents.map(document => (
                    <div
                      className="file-row"
                      key={document.fileId}
                    >

                      <div className="file-symbol">
                        {document.kind === "pdf"
                          ? <FileText />
                          : <FileSpreadsheet />}
                      </div>

                      <div className="file-meta">

                        <b>
                          {safeText(document.fileName)}
                        </b>

                        <small>
                          {fileDimensions(document)}
                          {" · "}
                          {document.uploadedAt
                            ? new Date(document.uploadedAt).toLocaleDateString()
                            : ""}
                        </small>

                      </div>

                      <button
                        className="text-button"
                        disabled={loadingConversation}
                        onClick={() => openDocument(document)}
                      >
                        Open
                      </button>

                    </div>
                  ))

                ) : (

                  <p>No saved files yet.</p>

                )}

              </div>

              {/* SELECTED FILE */}

              {fileInfo && (

                <>

                  <div className="file-row">

                    <div className="file-symbol">
                      {fileInfo.kind === "pdf"
                        ? <FileText />
                        : <FileSpreadsheet />}
                    </div>

                    <div className="file-meta">

                      <b>{safeText(fileInfo.fileName)}</b>

                      <small>
                        {safeText(fileInfo.type)}
                        {" · "}
                        {file
                          ? `${(file.size / 1024).toFixed(1)} KB`
                          : "Uploaded"}
                        {" · "}
                        {fileDimensions(fileInfo)}
                      </small>

                    </div>

                    <span className="file-status">
                      Uploaded
                    </span>

                    <button
                      className="remove-file"
                      aria-label="Remove uploaded file"
                      title="Remove file"
                      onClick={removeFile}
                    >
                      <Trash2 size={17} />
                    </button>

                  </div>

                  {/* PDF PREVIEW */}

                  {fileInfo.kind === "pdf" ? (

                    <div className="document-preview">

                      <h4>Document preview</h4>

                      {fileInfo.extractionWarning && (
                        <p className="extraction-warning">
                          {safeText(fileInfo.extractionWarning)}
                        </p>
                      )}

                      <pre>
                        {safeText(fileInfo.preview) ||
                          (fileInfo.extractionWarning
                            ? "No selectable text was extracted from this PDF."
                            : "")}

                        {fileInfo.previewTruncated
                          ? "\n\nPreview shortened. Ask AI about the full extracted document."
                          : ""}
                      </pre>

                    </div>

                  ) : (

                    /* SPREADSHEET PREVIEW */

                    <>

                      <div className="table-wrap">

                        <table>

                          <thead>
                            <tr>
                              {columns.map(column => (
                                <th key={column}>
                                  {column}
                                </th>
                              ))}
                            </tr>
                          </thead>

                          <tbody>

                            {preview.map((row, i) => (
                              <tr key={i}>
                                {columns.map(column => (
                                  <td key={column}>
                                    {safeText(row[column])}
                                  </td>
                                ))}
                              </tr>
                            ))}

                          </tbody>

                        </table>

                      </div>

                      <p className="table-foot">
                        Showing up to 10 preview rows.
                      </p>

                    </>

                  )}

                </>

              )}

            </section>

          ) : active === "Dashboard" ? (

            /* ================================================= */
            /* DASHBOARD */
            /* ================================================= */

            <>

              <div className="stats-grid">

                {stats.map(({ label, value, icon: Icon, change }) => (
                  <div className="stat-card" key={label}>

                    <div className="stat-top">
                      <span>{label}</span>

                      <div className="stat-icon">
                        <Icon size={18} />
                      </div>
                    </div>

                    <strong>{value}</strong>

                    <small>{change}</small>

                  </div>
                ))}

              </div>

              <div className="dashboard-grid">

                {/* ACTIVITY CHART */}

                <section className="content-card chart-card">

                  <div className="section-title">

                    <div>
                      <h3>Workspace activity</h3>
                      <p>
                        Overview of recent workspace activity
                      </p>
                    </div>

                    <button className="period-button">
                      Last 7 days
                      <ChevronDown size={15} />
                    </button>

                  </div>

                  <div className="chart-area">

                    <ResponsiveContainer
                      width="100%"
                      height="100%"
                    >

                      <AreaChart data={chartData}>

                        <defs>
                          <linearGradient
                            id="purpleFill"
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1"
                          >
                            <stop
                              offset="0%"
                              stopColor="#8B5CF6"
                              stopOpacity={0.2}
                            />

                            <stop
                              offset="100%"
                              stopColor="#8B5CF6"
                              stopOpacity={0}
                            />
                          </linearGradient>
                        </defs>

                        <CartesianGrid
                          stroke="#F0EDF7"
                          vertical={false}
                        />

                        <XAxis
                          dataKey="name"
                          axisLine={false}
                          tickLine={false}
                          tick={{
                            fill: "#9691A5",
                            fontSize: 13
                          }}
                        />

                        <YAxis
                          axisLine={false}
                          tickLine={false}
                          tick={{
                            fill: "#9691A5",
                            fontSize: 13
                          }}
                        />

                        <Tooltip />

                        <Area
                          type="monotone"
                          dataKey="value"
                          stroke="#8052D6"
                          strokeWidth={2.5}
                          fill="url(#purpleFill)"
                        />

                      </AreaChart>

                    </ResponsiveContainer>

                  </div>

                </section>

                {/* QUICK ACTIONS */}

                <section className="content-card quick-card">

                  <div className="section-title">

                    <div>
                      <h3>Quick actions</h3>
                      <p>Jump back into your workflow</p>
                    </div>

                  </div>

                  <button onClick={() => setActive("Excel Files")}>

                    <div className="quick-icon">
                      <CloudUpload />
                    </div>

                    <div>
                      <b>Upload a file</b>
                      <small>Add a PDF or spreadsheet</small>
                    </div>

                    <span>→</span>

                  </button>

                  <button onClick={() => setActive("AI Excel Chat")}>

                    <div className="quick-icon">
                      <Bot />
                    </div>

                    <div>
                      <b>Ask AI about data</b>
                      <small>Get answers in seconds</small>
                    </div>

                    <span>→</span>

                  </button>

                  <button onClick={() => setActive("Reports")}>

                    <div className="quick-icon">
                      <TrendingUp />
                    </div>

                    <div>
                      <b>View reports</b>
                      <small>Explore data insights</small>
                    </div>

                    <span>→</span>

                  </button>

                </section>

              </div>

              {/* RECENT FILE */}

              <section className="content-card recent-card">

                <div className="section-title">

                  <div>
                    <h3>Recent file</h3>
                    <p>
                      Your latest uploaded document or spreadsheet
                    </p>
                  </div>

                  <button
                    className="text-button"
                    onClick={() => setActive("Excel Files")}
                  >
                    View all
                  </button>

                </div>

                {fileInfo ? (

                  <div className="file-row">

                    <div className="file-symbol">
                      {fileInfo.kind === "pdf"
                        ? <FileText />
                        : <FileSpreadsheet />}
                    </div>

                    <div className="file-meta">

                      <b>{safeText(fileInfo.fileName)}</b>

                      <small>
                        {fileDimensions(fileInfo)}
                      </small>

                    </div>

                    <span className="file-status">
                      Ready
                    </span>

                  </div>

                ) : (

                  <div className="empty-state">

                    <div className="empty-icon">
                      <FileText size={25} />
                    </div>

                    <b>No files yet</b>

                    <p>
                      Upload a PDF or spreadsheet to explore its content.
                    </p>

                    <button
                      className="secondary-button"
                      onClick={() => inputRef.current?.click()}
                    >
                      Browse files
                    </button>

                  </div>

                )}

              </section>

            </>

          ) : active === "Reports" ? (

            <AnalyticsReports
              page={active}
              files={documents}
              selectedId={selectedWorkbookId}
              onSelect={id => {
                setSelectedWorkbookId(id);
                try { localStorage.setItem("technovalens.selectedWorkbookId", id); } catch { /* Storage may be disabled. */ }
              }}
            />

          ) : (

            /* ================================================= */
            /* OTHER PAGES */
            /* ================================================= */

            <section className="content-card placeholder">

              <div className="empty-icon">
                <BarChart3 size={26} />
              </div>

              <h3>{active} is coming next</h3>

              <p>
                This section will be connected to your uploaded
                workbook in the next development phase.
              </p>

              <button
                className="primary-button"
                onClick={() => setActive("Dashboard")}
              >
                Back to dashboard
              </button>

            </section>

          )}

          {/* FOOTER */}

          <footer>
            © 2026 TECHNOVALENS
            <span>Intelligent Excel. Clearer decisions.</span>
          </footer>

        </div>
      </main>
    </div>
  );
}
