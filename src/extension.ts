import * as vscode from 'vscode';
import axios from 'axios';

let activePanel: vscode.WebviewPanel | undefined = undefined;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('photon.open', () => {
      openWebview(context);
    }),
  );
}

function openWebview(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (activePanel) {
    activePanel.reveal(vscode.ViewColumn.Beside);
    return activePanel;
  }

  const panel = vscode.window.createWebviewPanel(
    'restClient',
    'Photon',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  activePanel = panel;
  panel.onDidDispose(
    () => {
      activePanel = undefined;
    },
    null,
    context.subscriptions,
  );

  panel.webview.html = getWebviewContent(context);

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.command === 'sendRequest') {
      const startTime = Date.now();
      try {
        let headers = {};
        if (message.headers && message.headers.trim()) {
          try {
            headers = JSON.parse(message.headers);
          } catch (e) {
            throw new Error('Invalid Headers JSON format');
          }
        }

        if (message.authType === 'basic' && message.username) {
          const credentials = Buffer.from(
            `${message.username}:${message.password || ''}`,
          ).toString('base64');
          headers = { ...headers, Authorization: `Basic ${credentials}` };
        } else if (message.authType === 'bearer' && message.token) {
          headers = {
            ...headers,
            Authorization: `Bearer ${message.token}`,
          };
        }

        let body = undefined;
        if (message.method !== 'GET' && message.body && message.body.trim()) {
          try {
            body = JSON.parse(message.body);
          } catch (e) {
            body = message.body;
          }
        }

        let url = message.url.trim();
        if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
          url = 'http://' + url;
        }

        const history: any[] = context.globalState.get('requestHistory') || [];
        const newEntry = {
          id: Date.now(),
          method: message.method,
          url: url,
          headers: message.headers,
          body: message.body,
          auth: {
            type: message.authType,
            token: message.token,
            username: message.username,
            password: message.password,
          },
          timestamp: new Date().toLocaleTimeString(),
        };
        history.unshift(newEntry);
        if (history.length > 20) {
          history.pop();
        }
        await context.globalState.update('requestHistory', history);

        const res = await axios({
          method: message.method,
          url: url,
          headers: headers,
          data: body,
          timeout: 30000,
        });

        const duration = Date.now() - startTime;

        panel.webview.postMessage({
          command: 'response',
          status: res.status,
          statusText: res.statusText,
          data: res.data,
          time: duration,
          contentType: res.headers['content-type'],
          history: history,
        });
      } catch (error: any) {
        const duration = Date.now() - startTime;
        panel.webview.postMessage({
          command: 'response',
          status: error.response?.status || 'Error',
          statusText: error.response?.statusText || error.message,
          data: error.response?.data || error.message,
          time: duration,
          contentType: error.response?.headers?.['content-type'],
          history: context.globalState.get('requestHistory') || [],
        });
      }
    } else if (message.command === 'loadHistory') {
      const history = context.globalState.get('requestHistory') || [];
      panel.webview.postMessage({
        command: 'historyData',
        history: history,
      });
    } else if (message.command === 'clearHistory') {
      await context.globalState.update('requestHistory', []);
      panel.webview.postMessage({ command: 'historyData', history: [] });
    }
  });

  return panel;
}

function getWebviewContent(context: vscode.ExtensionContext) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Photon</title>
    <style>
        :root {
            --bg: #000000;
            --surface: #0a0a0a;
            --border: #1a1a1a;
            --accent: #00f2ff;
            --error: #ff0055;
            --success: #00ffaa;
            --text: #e0e0e0;
            --text-dim: #808080;
            --neon-pink: #ff00ff;
        }

        body {
            background-color: var(--bg);
            color: var(--text);
            font-family: 'Inter', -apple-system, system-ui, sans-serif;
            margin: 0;
            padding: 12px;
            display: flex;
            flex-direction: column;
            height: 100vh;
            box-sizing: border-box;
            font-size: 13px;
        }

        .minimal-input-group {
            display: flex;
            gap: 4px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 4px;
            margin-bottom: 12px;
        }

        select, input {
            background: transparent;
            color: var(--text);
            border: none;
            outline: none;
            font-family: inherit;
            font-size: 13px;
            padding: 4px 8px;
        }

        select#method { 
            width: 100px; 
            font-weight: 800; 
            cursor: pointer;
            border-right: 1px solid var(--border);
            transition: all 0.2s;
        }

        .m-GET { color: var(--accent) !important; text-shadow: 0 0 5px var(--accent); }
        .m-POST { color: var(--success) !important; text-shadow: 0 0 5px var(--success); }
        .m-PUT { color: #ffcc00 !important; text-shadow: 0 0 5px #ffcc00; }
        .m-PATCH { color: #ff8800 !important; text-shadow: 0 0 5px #ff8800; }
        .m-DELETE { color: var(--neon-pink) !important; text-shadow: 0 0 5px var(--neon-pink); }

        input.url { flex: 1; font-family: monospace; }

        button.send-btn {
            background: transparent;
            color: var(--accent);
            border: 1px solid var(--accent);
            border-radius: 6px;
            padding: 0 16px;
            font-weight: 800;
            text-transform: uppercase;
            font-size: 10px;
            letter-spacing: 0.1em;
            cursor: pointer;
            transition: all 0.2s;
        }

        button.send-btn:hover {
            background: var(--accent);
            color: var(--bg);
            box-shadow: 0 0 12px var(--accent);
        }

        .tabs {
            display: flex;
            gap: 20px;
            margin-bottom: 8px;
        }

        .tab {
            font-size: 10px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            color: var(--text-dim);
            cursor: pointer;
            padding-bottom: 4px;
            border-bottom: 2px solid transparent;
            transition: 0.2s;
        }

        .tab.active {
            color: var(--accent);
            border-bottom-color: var(--accent);
        }

        .tab-content { display: none; height: 15vh; }
        .tab-content.active { display: flex; flex-direction: column; }

        textarea {
            width: 100%;
            flex: 1;
            background: var(--surface);
            color: var(--text);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 8px;
            font-family: monospace;
            font-size: 12px;
            resize: none;
            outline: none;
        }

        .beautify-bar {
            display: flex;
            justify-content: flex-end;
            margin-top: 4px;
        }

        .sec-btn {
            font-size: 9px;
            background: transparent;
            color: var(--text-dim);
            border: 1px solid var(--border);
            padding: 2px 8px;
            border-radius: 4px;
            cursor: pointer;
        }

        .response-meta {
            margin-top: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            border-top: 1px solid var(--border);
        }

        .status-info { display: flex; align-items: center; gap: 12px; font-size: 11px; font-weight: 800; }
        .status-txt { color: var(--success); }
        .status-err { color: var(--error); }
        .time-txt { color: var(--text-dim); font-family: monospace; }

        .view-btns { display: flex; gap: 8px; }
        .v-btn {
            font-size: 9px;
            color: var(--text-dim);
            cursor: pointer;
            font-weight: 800;
            text-transform: uppercase;
        }
        .v-btn.active { color: var(--accent); }

        .response-viewport {
            flex: 1;
            overflow: auto;
            border-top: 1px solid var(--border);
            padding-top: 8px;
        }

        pre {
            margin: 0;
            font-family: monospace;
            font-size: 12px;
            line-height: 1.4;
            color: #dcdcdc;
            white-space: pre-wrap;
        }

        .history-list {
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .history-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 6px 10px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 6px;
            cursor: pointer;
            transition: 0.2s;
        }
        .history-item:hover { border-color: var(--accent); }
        .hist-method { font-size: 9px; font-weight: 800; color: var(--accent); width: 45px; }
        .hist-url { font-size: 11px; color: var(--text); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .hist-time { font-size: 9px; color: var(--text-dim); }

        .loader {
            display: none;
            height: 1px;
            background: var(--accent);
            box-shadow: 0 0 8px var(--accent);
            width: 0;
            transition: width 0.3s;
            margin-bottom: 8px;
        }
    </style>
</head>
<body>
    <div class="minimal-input-group">
        <select id="method">
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
            <option value="DELETE">DELETE</option>
        </select>
        <input type="text" id="url" class="url" placeholder="https://api.endpoint.com">
        <button id="send" class="send-btn">SEND</button>
    </div>

    <div class="loader" id="loader"></div>

    <div class="tabs">
        <div class="tab active" data-tab="headers">Headers</div>
        <div class="tab" data-tab="body">Body</div>
        <div class="tab" data-tab="auth">Auth</div>
        <div class="tab" data-tab="history" onclick="requestHistory()">History</div>
    </div>

    <div id="headers" class="tab-content active">
        <textarea id="headers-input" placeholder='{ "Content-Type": "application/json" }'></textarea>
    </div>

    <div id="body" class="tab-content">
        <textarea id="body-input" placeholder='{ "id": 1 }'></textarea>
        <div class="beautify-bar">
            <button class="sec-btn" onclick="beautifyBody()">Format JSON</button>
        </div>
    </div>

    <div id="auth" class="tab-content">
        <select id="auth-type" style="width: 100%; background: var(--surface); border: 1px solid var(--border); margin-bottom: 8px;">
            <option value="none">NO AUTH</option>
            <option value="bearer">BEARER TOKEN</option>
            <option value="basic">BASIC AUTH</option>
        </select>
        <div id="auth-bearer" style="display: none;">
            <input type="text" id="token" placeholder="Bearer Token" style="width: 100%; border-bottom: 1px solid var(--border);">
        </div>
        <div id="auth-basic" style="display: none; display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <input type="text" id="username" placeholder="User" style="border-bottom: 1px solid var(--border);">
            <input type="password" id="password" placeholder="Pass" style="border-bottom: 1px solid var(--border);">
        </div>
    </div>

    <div id="history" class="tab-content">
        <div class="history-list" id="history-container"></div>
        <div class="beautify-bar">
            <button class="sec-btn" onclick="clearHistory()">Clear History</button>
        </div>
    </div>

    <div class="response-meta">
        <div class="status-info">
            <span id="status-val"></span>
            <span id="time-val" class="time-txt"></span>
        </div>
        <div class="view-btns" id="v-control" style="display: none;">
            <span class="v-btn active" data-view="pretty">Pretty</span>
            <span class="v-btn" data-view="raw">Raw</span>
        </div>
    </div>

    <div class="response-viewport">
        <pre id="response-content">Ready.</pre>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let lastResponse = null;
        let currentView = 'pretty';

        const methodEl = document.getElementById('method');

        function updateMethodColor() {
            const method = methodEl.value;
            methodEl.className = 'm-' + method;
        }

        methodEl.addEventListener('change', updateMethodColor);
        updateMethodColor();

        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.tab).classList.add('active');
            });
        });

        document.getElementById('auth-type').addEventListener('change', (e) => {
            document.getElementById('auth-bearer').style.display = e.target.value === 'bearer' ? 'block' : 'none';
            document.getElementById('auth-basic').style.display = e.target.value === 'basic' ? 'grid' : 'none';
        });

        document.querySelectorAll('.v-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.v-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentView = btn.dataset.view;
                renderResponse();
            });
        });

        function beautifyBody() {
            const el = document.getElementById('body-input');
            try {
                const obj = JSON.parse(el.value);
                el.value = JSON.stringify(obj, null, 2);
            } catch (e) {}
        }

        function requestHistory() {
            vscode.postMessage({ command: 'loadHistory' });
        }

        function clearHistory() {
            if (confirm('Are you sure you want to clear your request history?')) {
                vscode.postMessage({ command: 'clearHistory' });
            }
        }

        const sendBtn = document.getElementById('send');
        const loader = document.getElementById('loader');

        sendBtn.addEventListener('click', () => {
            sendBtn.textContent = '...';
            sendBtn.disabled = true;
            loader.style.display = 'block';
            loader.style.width = '100%';
            
            vscode.postMessage({
                command: 'sendRequest',
                method: document.getElementById('method').value,
                url: document.getElementById('url').value,
                headers: document.getElementById('headers-input').value,
                body: document.getElementById('body-input').value,
                authType: document.getElementById('auth-type').value,
                token: document.getElementById('token').value,
                username: document.getElementById('username').value,
                password: document.getElementById('password').value
            });
        });

        function renderResponse() {
            if (!lastResponse) return;
            const contentEl = document.getElementById('response-content');
            
            if (currentView === 'pretty') {
                const cType = (lastResponse.contentType || '').toLowerCase();
                if (cType.includes('json') || (typeof lastResponse.data === 'object')) {
                    contentEl.textContent = JSON.stringify(lastResponse.data, null, 2);
                } else {
                    contentEl.textContent = lastResponse.data;
                }
            } else {
                contentEl.textContent = typeof lastResponse.data === 'string' 
                    ? lastResponse.data 
                    : JSON.stringify(lastResponse.data, null, 2);
            }
        }

        function loadFromHistory(item) {
            document.getElementById('method').value = item.method;
            updateMethodColor();
            document.getElementById('url').value = item.url;
            document.getElementById('headers-input').value = item.headers || '';
            document.getElementById('body-input').value = item.body || '';
            
            const auth = item.auth || { type: 'none' };
            document.getElementById('auth-type').value = auth.type;
            document.getElementById('token').value = auth.token || '';
            document.getElementById('username').value = auth.username || '';
            document.getElementById('password').value = auth.password || '';
            
            document.getElementById('auth-type').dispatchEvent(new Event('change'));
            document.querySelector('.tab[data-tab="headers"]').click();
        }

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'response') {
                lastResponse = message;
                sendBtn.textContent = 'SEND';
                sendBtn.disabled = false;
                loader.style.width = '0';
                setTimeout(() => { loader.style.display = 'none'; }, 300);

                const statusVal = document.getElementById('status-val');
                statusVal.textContent = message.status;
                statusVal.className = (message.status >= 200 && message.status < 300) ? 'status-txt' : 'status-err';
                
                document.getElementById('time-val').textContent = message.time + 'ms';
                document.getElementById('v-control').style.display = 'flex';
                
                renderResponse();
            } else if (message.command === 'historyData') {
                const container = document.getElementById('history-container');
                container.innerHTML = '';
                message.history.forEach(item => {
                    const el = document.createElement('div');
                    el.className = 'history-item';
                    el.innerHTML = \`
                        <span class="hist-method m-\${item.method}">\${item.method}</span>
                        <span class="hist-url">\${item.url}</span>
                        <span class="hist-time">\${item.timestamp}</span>
                    \`;
                    el.onclick = () => loadFromHistory(item);
                    container.appendChild(el);
                });
            }
        });
    </script>
</body>
</html>`;
}
