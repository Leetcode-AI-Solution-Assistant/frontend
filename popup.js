/* global React, ReactDOM, chrome */

const { useEffect, useRef, useState, useCallback } = React;
const { createRoot } = ReactDOM;

const BACKEND_BASE_URL = "https://backend-j8gu.onrender.com";
const STORAGE_KEYS = {
  session: "lcAssistantSession",
  initialized: "lcAssistantInitialized",
};

function buildAuthHeaders(session) {
  if (!session?.sessionId || !session?.authToken) return {};
  return {
    "X-Session-ID": session.sessionId,
    "X-Session-Auth": session.authToken,
  };
}

function isLeetCodeQuestionUrl(url) {
  return typeof url === "string" && /https?:\/\/leetcode\.com\/problems\//i.test(url || "");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function extractQuestionFromTab(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const url = window.location.href;
      if (!/leetcode\.com\/problems\//i.test(url)) {
        return { ok: false, reason: "Open a LeetCode question to use the assistant." };
      }

      const grabTitle = () => {
        const el = document.querySelector('[data-cy="question-title"]') || document.querySelector("h1");
        if (el) return el.textContent.trim();
        return document.title || "";
      };

      let titleText = grabTitle();
      let questionNumber = null;

      const numberMatch = titleText.match(/^(\d+)/);
      if (numberMatch) {
        questionNumber = numberMatch[1];
      }

      if (!questionNumber) {
        const html = document.documentElement.innerHTML;
        const match = html.match(/"questionFrontendId":"(\d+)"/);
        if (match) {
          questionNumber = match[1];
        }
      }

      return {
        ok: Boolean(questionNumber),
        questionNumber: questionNumber || null,
        title: titleText || null,
        reason: questionNumber ? null : "Couldn't locate the question number. Expand the description and try again.",
      };
    },
  });

  return result?.result || { ok: false, reason: "Unable to read the page" };
}

async function readStorage(key) {
  const result = await chrome.storage.local.get([key]);
  return result[key];
}

async function writeStorage(entries) {
  return chrome.storage.local.set(entries);
}

async function removeStorage(keys) {
  return chrome.storage.local.remove(keys);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMarkdown(md) {
  if (typeof md !== "string") return "";

  // Extract fenced code blocks first so we don't mangle their content.
  const codeBlocks = [];
  let text = md.replace(/```([\s\S]*?)```/g, (_match, code) => {
    const index = codeBlocks.length;
    codeBlocks.push(`<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`);
    return `@@CODEBLOCK${index}@@`;
  });

  // Escape any remaining HTML.
  text = escapeHtml(text);

  // Headings
  text = text.replace(/^(#{1,6})\s+(.+)$/gm, (_m, hashes, content) => {
    const level = hashes.length;
    return `<h${level}>${content.trim()}</h${level}>`;
  });

  // Blockquotes
  text = text.replace(/^>\s?(.*)$/gm, "<blockquote><p>$1</p></blockquote>");

  // Ordered lists
  text = text.replace(/^(?:\s*\d+\.\s+.+\n?)+/gm, (block) => {
    const items = block
      .trim()
      .split(/\n/)
      .map((line) => line.replace(/^\s*\d+\.\s+/, ""))
      .map((line) => `<li>${line}</li>`)
      .join("");
    return `<ol>${items}</ol>`;
  });

  // Unordered lists
  text = text.replace(/^(?:\s*[-*+]\s+.+\n?)+/gm, (block) => {
    const items = block
      .trim()
      .split(/\n/)
      .map((line) => line.replace(/^\s*[-*+]\s+/, ""))
      .map((line) => `<li>${line}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  });

  // Inline code
  text = text.replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`);

  // Bold and italics
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(\*|_)([^*_]+)\1/g, "<em>$2</em>");

  // Links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // Paragraphs: wrap loose text separated by blank lines.
  text = text
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      if (/^<\/?(h\d|ul|ol|li|pre|blockquote)/i.test(trimmed)) {
        return trimmed;
      }
      return `<p>${trimmed}</p>`;
    })
    .join("");

  // Restore code blocks
  codeBlocks.forEach((block, idx) => {
    text = text.replace(`@@CODEBLOCK${idx}@@`, block);
  });

  return text;
}

function Bubble({ role, content }) {
  const isAssistant = role === "assistant";
  const body = isAssistant
    ? React.createElement("div", { className: "markdown", dangerouslySetInnerHTML: { __html: renderMarkdown(content) } })
    : React.createElement("div", null, content);

  return React.createElement(
    "div",
    { className: `bubble ${role}` },
    React.createElement("div", { className: "from" }, role === "assistant" ? "AI" : "You"),
    body
  );
}

function App() {
  const [session, setSession] = useState(null);
  const [username, setUsername] = useState("");
  const [question, setQuestion] = useState({ status: "checking" });
  const [pendingQuestion, setPendingQuestion] = useState(null);
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [status, setStatus] = useState("");
  const [refreshingQuestion, setRefreshingQuestion] = useState(false);
  const chatRef = useRef(null);
  const questionRef = useRef(question);
  const lastTabUrlRef = useRef(null);

  useEffect(() => {
    bootstrap();
  }, []);

  useEffect(() => {
    questionRef.current = question;
  }, [question]);

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages]);

  async function bootstrap() {
    const storedSession = await readStorage(STORAGE_KEYS.session);
    if (storedSession?.sessionId && storedSession?.authToken) {
      setSession(storedSession);
      setUsername(storedSession.username || "");
    } else if (storedSession) {
      // Clear legacy sessions without auth tokens to avoid broken requests.
      await removeStorage([STORAGE_KEYS.session]);
    }

    const activeTab = await getActiveTab();
    if (!activeTab) {
      setQuestion({ status: "error", message: "No active tab found." });
      return null;
    }

    if (!isLeetCodeQuestionUrl(activeTab.url)) {
      setQuestion({ status: "notLeetCode" });
      return null;
    }

    setQuestion({ status: "loading" });
    const pageInfo = await extractQuestionFromTab(activeTab.id);
    if (!pageInfo.ok || !pageInfo.questionNumber) {
      setQuestion({ status: "error", message: pageInfo.reason || "Couldn't read question details." });
      return null;
    }

    const normalized = {
      status: "ready",
      number: Number(pageInfo.questionNumber),
      title: pageInfo.title || `LeetCode Question #${pageInfo.questionNumber}`,
    };
    setQuestion(normalized);
    lastTabUrlRef.current = activeTab.url;

    if (storedSession) {
      await initializeForQuestion(storedSession, normalized.number, normalized.title);
    }

    return normalized;
  }

  async function initializeForQuestion(sess, questionNumber, questionTitle) {
    setStatus("Syncing question with backend...");
    try {
      if (!sess?.authToken) {
        throw new Error("Missing session auth token. Reset the session.");
      }
      await ensureQuestionInitialized(sess.sessionId, sess.authToken, questionNumber, questionTitle);
      await hydrateMessages(sess.sessionId, sess.authToken);
      setStatus("");
    } catch (err) {
      console.error(err);
      setStatus(err?.message || "Failed to initialize question.");
    }
  }

  async function ensureQuestionInitialized(sessionId, authToken, questionNumber, questionTitle) {
    const initMap = (await readStorage(STORAGE_KEYS.initialized)) || {};
    const sessionMap = initMap[sessionId] || {};
    if (sessionMap[questionNumber]) return;

    if (!authToken) {
      throw new Error("Session auth token missing.");
    }

    const resp = await fetch(`${BACKEND_BASE_URL}/questions`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...buildAuthHeaders({ sessionId, authToken }),
      },
      body: JSON.stringify({
        lc_question_number: Number(questionNumber),
        lc_question_title: questionTitle || null,
      }),
    });

    const data = await resp.json();
    if (!resp.ok || data?.ok === false) {
      throw new Error(data?.error || data?.detail || "Backend rejected the question.");
    }

    await writeStorage({
      [STORAGE_KEYS.initialized]: {
        ...initMap,
        [sessionId]: { ...sessionMap, [questionNumber]: Date.now() },
      },
    });
  }

  async function hydrateMessages(sessionId, authToken) {
    if (!authToken) {
      throw new Error("Session auth token missing.");
    }

    const resp = await fetch(`${BACKEND_BASE_URL}/whoami`, {
      method: "GET",
      credentials: "include",
      headers: buildAuthHeaders({ sessionId, authToken }),
    });

    if (!resp.ok) {
      throw new Error("Could not load session messages.");
    }
    const data = await resp.json();
    if (Array.isArray(data?.messages)) {
      setMessages(
        data.messages.map((m, idx) => ({
          role: m.role,
          content: m.content,
          key: m.ts || `${m.role}-${idx}`,
        }))
      );
    }
  }

  async function handleCreateSession(event) {
    if (event) event.preventDefault();
    const name = username.trim();
    if (!name) return;

    await createSessionWithName(name);
  }

  async function createSessionWithName(name, questionOverride) {
    const targetQuestion = questionOverride || question;
    setBusy(true);
    setStatus("Creating session...");
    try {
      const resp = await fetch(`${BACKEND_BASE_URL}/create_session/${encodeURIComponent(name)}`, {
        method: "POST",
        credentials: "include",
      });
      const data = await resp.json();
      if (!resp.ok || data?.ok === false) {
        throw new Error(data?.error || data?.detail || "Unable to create session.");
      }

      if (!data?.auth_token) {
        throw new Error("Server did not return an auth token.");
      }

      const newSession = {
        sessionId: data.session_id,
        username: data.username || name,
        authToken: data.auth_token,
      };
      setSession(newSession);
      await writeStorage({ [STORAGE_KEYS.session]: newSession });
      setMessages([]);

      if (targetQuestion?.status === "ready") {
        await initializeForQuestion(newSession, targetQuestion.number, targetQuestion.title);
      }

      setStatus("Session ready.");
    } catch (err) {
      console.error(err);
      setStatus(err?.message || "Session creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSendMessage(event) {
    if (event) event.preventDefault();
    if (!session || question.status !== "ready" || isSending) return;
    if (!session.authToken) {
      setStatus("Session auth token missing. Reset the session.");
      return;
    }

    const text = chatInput.trim();
    if (!text) return;

    const tempMessage = { role: "assistant", content: "Thinking...", temp: true };
    const userMessage = { role: "user", content: text };
    setChatInput("");
    setIsSending(true);
    setMessages((prev) => [...prev, userMessage, tempMessage]);
    setStatus("Sending message...");

    try {
      const resp = await fetch(`${BACKEND_BASE_URL}/chat`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...buildAuthHeaders(session),
        },
        body: JSON.stringify({ text }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        throw new Error(data?.detail || data?.error || "Chat request failed.");
      }

      // Refresh from the backend so history stays authoritative and we see prior turns.
      await hydrateMessages(session.sessionId, session.authToken);
      setStatus("");
    } catch (err) {
      setMessages((prev) => {
        const next = prev.filter((m) => !m.temp);
        next.push({ role: "assistant", content: `Error: ${err?.message || "Something went wrong"}` });
        return next;
      });
      setStatus(err?.message || "Could not send message.");
  } finally {
    setIsSending(false);
  }
}

  async function resetSession() {
    const currentSession = session;
    setBusy(true);
    setStatus("Resetting session...");
    let errorMessage = "";

    try {
      if (currentSession) {
        const resp = await fetch(`${BACKEND_BASE_URL}/delete_session`, {
          method: "POST",
          credentials: "include",
          headers: buildAuthHeaders(currentSession),
        });

        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          throw new Error(data?.detail || data?.error || "Failed to delete session.");
        }
      }
    } catch (err) {
      console.error(err);
      errorMessage = err?.message || "Failed to reset session.";
    } finally {
      // Always clear local storage to avoid stale state.
      await removeStorage([STORAGE_KEYS.session]);
      const initMap = (await readStorage(STORAGE_KEYS.initialized)) || {};
      if (currentSession?.sessionId && initMap[currentSession.sessionId]) {
        const { [currentSession.sessionId]: _removed, ...rest } = initMap;
        await writeStorage({ [STORAGE_KEYS.initialized]: rest });
      }

      setSession(null);
      setMessages([]);
      setBusy(false);
      setStatus(errorMessage);
    }
  }

  const detectQuestionForTab = useCallback(async (tab) => {
    try {
      if (!tab || !isLeetCodeQuestionUrl(tab.url)) {
        setPendingQuestion(null);
        return;
      }

      const pageInfo = await extractQuestionFromTab(tab.id);
      if (!pageInfo.ok || !pageInfo.questionNumber) {
        setPendingQuestion(null);
        return;
      }

      const normalized = {
        number: Number(pageInfo.questionNumber),
        title: pageInfo.title || `LeetCode Question #${pageInfo.questionNumber}`,
      };

      const current = questionRef.current;
      if (!current || current.status !== "ready" || current.number !== normalized.number) {
        setPendingQuestion((prev) => {
          if (prev?.number === normalized.number) return prev;
          return normalized;
        });
      } else {
        setPendingQuestion(null);
      }
    } catch (err) {
      console.warn("Failed to detect question change", err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const checkActiveTab = () => {
      if (cancelled) return;
      getActiveTab()
        .then((tab) => {
          if (cancelled || !tab) return;
          if (tab.url !== lastTabUrlRef.current) {
            lastTabUrlRef.current = tab.url;
            detectQuestionForTab(tab);
          }
        })
        .catch((err) => console.warn("Tab check failed", err));
    };

    const handleUpdated = (_tabId, changeInfo, tab) => {
      if (changeInfo.url || changeInfo.status === "complete") {
        lastTabUrlRef.current = tab?.url || lastTabUrlRef.current;
        detectQuestionForTab(tab);
      }
    };

    const handleActivated = () => {
      checkActiveTab();
    };

    chrome.tabs.onUpdated.addListener(handleUpdated);
    chrome.tabs.onActivated.addListener(handleActivated);
    const interval = setInterval(checkActiveTab, 2000);

    return () => {
      cancelled = true;
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      chrome.tabs.onActivated.removeListener(handleActivated);
      clearInterval(interval);
    };
  }, [detectQuestionForTab]);

  async function handleReloadForNewQuestion() {
    setRefreshingQuestion(true);
    setPendingQuestion(null);
    setQuestion({ status: "loading" });
    const currentSession = session;
    const currentUsername = username.trim();

    try {
      if (currentSession) {
        try {
          const resp = await fetch(`${BACKEND_BASE_URL}/delete_session`, {
            method: "POST",
            credentials: "include",
            headers: buildAuthHeaders(currentSession),
          });
          if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data?.detail || data?.error || "Failed to delete session.");
          }
        } catch (err) {
          console.error("Failed to delete session during reload", err);
        } finally {
          await removeStorage([STORAGE_KEYS.session]);
          const initMap = (await readStorage(STORAGE_KEYS.initialized)) || {};
          if (currentSession?.sessionId && initMap[currentSession.sessionId]) {
            const { [currentSession.sessionId]: _removed, ...rest } = initMap;
            await writeStorage({ [STORAGE_KEYS.initialized]: rest });
          }
          setSession(null);
          setMessages([]);
        }
      }

      const latestQuestion = await bootstrap();

      if (currentUsername) {
        await createSessionWithName(currentUsername, latestQuestion || question);
      }
    } finally {
      setRefreshingQuestion(false);
    }
  }

  const header = React.createElement(
    "div",
    { className: "header" },
    React.createElement(
      "div",
      { className: "brand" },
      React.createElement("img", { src: "logo.svg", alt: "LeetCode Solution Assistant logo" }),
      React.createElement("div", { className: "title" }, "LeetCode Solution Assistant"),
      question.status === "ready"
        ? React.createElement("div", { className: "helper" }, `${question.title} ( #${question.number} )`)
        : React.createElement("div", { className: "helper" }, "Only active on a LeetCode question page")
    ),
    React.createElement(
      "div",
      { className: "pill" },
      question.status === "ready" ? "Question detected" : "Idle"
    )
  );

  if (question.status === "notLeetCode") {
    return React.createElement(
      "div",
      { className: "card" },
      header,
      React.createElement(
        "div",
        { className: "status" },
        "Open a LeetCode question page (e.g., problems/slug/description) and reopen the extension."
      )
    );
  }

  if (question.status === "error") {
    return React.createElement(
      "div",
      { className: "card" },
      header,
      React.createElement("div", { className: "status error" }, question.message || "Something went wrong while reading the page." )
    );
  }

  const reloadPrompt = pendingQuestion
    ? React.createElement(
        "div",
        { className: "status" },
        React.createElement("div", null, `New question detected: ${pendingQuestion.title} (#${pendingQuestion.number})`),
        React.createElement(
          "div",
          { className: "input-row", style: { marginTop: "8px" } },
          React.createElement(
            "button",
            {
              type: "button",
              onClick: handleReloadForNewQuestion,
              disabled: refreshingQuestion || busy || isSending,
            },
            refreshingQuestion ? "Reloading..." : "Reload for this question"
          )
        ),
        React.createElement("div", { className: "helper" }, "Reload to sync the assistant with the current page.")
      )
    : null;

  const sessionBlock = React.createElement(
    "div",
    { className: "section" },
    React.createElement("div", { className: "label" }, "Session"),
    session
      ? React.createElement(
          React.Fragment,
          null,
          React.createElement(
            "div",
            { className: "helper" },
            `Signed in as ${session.username}`
          ),
          React.createElement(
            "div",
            { className: "helper" },
            `Session ID: ${session.sessionId}`
          ),
          React.createElement(
            "div",
            { className: "input-row", style: { marginTop: "8px" } },
            React.createElement(
              "button",
              { onClick: resetSession, type: "button", disabled: busy },
              "Reset"
            )
          )
        )
      : React.createElement(
          "form",
          { className: "input-row", onSubmit: handleCreateSession },
          React.createElement("input", {
            type: "text",
            placeholder: "Pick a username",
            value: username,
            onChange: (e) => setUsername(e.target.value),
            disabled: busy,
            required: true,
          }),
          React.createElement(
            "button",
            { type: "submit", disabled: busy },
            busy ? "Creating..." : "Create"
          )
        )
  );

  const chatArea = React.createElement(
    "div",
    { className: "section chat-section" },
    React.createElement("div", { className: "label" }, "Chat"),
    React.createElement(
      "div",
      { className: "chat", ref: chatRef },
      messages.length === 0
        ? React.createElement("div", { className: "helper" }, "No messages yet. Ask something about this question.")
        : messages.map((m, idx) => React.createElement(Bubble, { key: m.key || idx, role: m.role, content: m.content }))
    ),
    React.createElement(
      "form",
      { className: "input-area", onSubmit: handleSendMessage },
      React.createElement("textarea", {
        rows: 3,
        placeholder: session ? "Ask the AI about this question..." : "Create a session first",
        value: chatInput,
        onChange: (e) => setChatInput(e.target.value),
        disabled: !session || isSending || question.status !== "ready",
      }),
      React.createElement(
        "div",
        { className: "chat-actions" },
        React.createElement(
          "button",
          { type: "submit", disabled: !session || isSending || question.status !== "ready" },
          isSending ? "Sending..." : "Send"
        ),
        React.createElement(
          "div",
          { className: "helper" },
          session ? "Messages are stored in your backend session." : "Create a username to start chatting."
        )
      )
    )
  );

  return React.createElement(
    "div",
    { className: "card" },
    header,
    question.status === "loading"
      ? React.createElement("div", { className: "status" }, "Reading the LeetCode page...")
      : null,
    question.status === "ready" ? React.createElement(
      React.Fragment,
      null,
      reloadPrompt,
      React.createElement(
        "div",
        { className: "status" },
        session
          ? `Talking about Question #${question.number}`
          : "Create a username to start a session."
      ),
      sessionBlock,
      chatArea,
      status
        ? React.createElement(
            "div",
            { className: `status${status.toLowerCase().includes("fail") ? " error" : ""}` },
            status
          )
        : null
    ) : null
  );
}

const container = document.getElementById("root");
const root = createRoot(container);
root.render(React.createElement(App));
