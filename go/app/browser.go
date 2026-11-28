// Browsers, as in server/browser.ts:
//   - A headless one, never visible, for rendering PDFs and reading public job pages: Edge (or Chrome)
//     started by chromedp with a throwaway profile, removed when it closes.
//   - Your own, everyday browser, reached in the TS server through Microsoft's Playwright extension.
//     The Go backend has no relay for that yet (see relay notes in the README), so newVisiblePage
//     only works with the dev switch RA_AGENT_HEADLESS=1, which opens the agent's tab in the
//     headless browser instead (used by the end-to-end check on the local fixtures).
//
// Page and Locator below are a small Playwright-like layer over raw CDP calls; only what the
// agent, the posting reader and the PDF renderer use.
package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/inspector"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/cdproto/target"
	"github.com/chromedp/chromedp"
)

const ExtensionURL = "https://chromewebstore.google.com/detail/mmlmfjhmonkocbjadbfplnigmagldckm"

// BrowserState: off = not connected; waiting = connecting; on = connected.
type BrowserState struct {
	Status   string `json:"status"`
	Error    string `json:"error"`
	TokenSet bool   `json:"tokenSet"`
}

// agentHeadless is the dev-only switch: the agent's "visible" tabs open in the headless browser.
func agentHeadless() bool {
	v := os.Getenv("RA_AGENT_HEADLESS")
	return v != "" && v != "0" && v != "false"
}

func browserState() BrowserState {
	st := BrowserState{Status: "off", TokenSet: GetSettings().ExtensionToken != ""}
	if agentHeadless() {
		hlMu.Lock()
		if hl != nil {
			st.Status = "on"
		}
		hlMu.Unlock()
	} else {
		st.Error = relayUnavailable()
	}
	return st
}

func browserOpen() bool {
	if !agentHeadless() {
		return false
	}
	hlMu.Lock()
	defer hlMu.Unlock()
	return hl != nil
}

func relayUnavailable() string {
	which := "Edge"
	if GetSettings().BrowserChannel == "chrome" {
		which = "Chrome"
	}
	return "Go 版后端还不能连接你自己的 " + which + "（Playwright 扩展的中继没有移植）：要让助手自动填表，请用 TypeScript 版后端（pnpm dev）。"
}

var (
	closeMu        sync.Mutex
	closeListeners = map[int]func(){}
	closeSeq       int
)

// onBrowserClosed registers fn for when the agent's browser goes away; the returned func unregisters it.
func onBrowserClosed(fn func()) func() {
	closeMu.Lock()
	defer closeMu.Unlock()
	closeSeq++
	id := closeSeq
	closeListeners[id] = fn
	return func() {
		closeMu.Lock()
		delete(closeListeners, id)
		closeMu.Unlock()
	}
}

func fireBrowserClosed() {
	closeMu.Lock()
	fns := []func(){}
	for _, fn := range closeListeners {
		fns = append(fns, fn)
	}
	closeMu.Unlock()
	for _, fn := range fns {
		safely("browser closed", fn)
	}
}

// getContext / reconnect: connecting to your own browser.
func reconnect() error {
	if agentHeadless() {
		_, err := getHeadless()
		emit("browser")
		return err
	}
	return errors.New(relayUnavailable())
}

// newVisiblePage opens a tab for the agent (and for postings that need a signed-in session).
func newVisiblePage(u string) (*Page, error) {
	if !agentHeadless() {
		return nil, errors.New(relayUnavailable())
	}
	b, err := getHeadless()
	if err != nil {
		return nil, err
	}
	p, err := b.NewPage(pageOpts{})
	if err != nil {
		return nil, err
	}
	if u != "" {
		if err := p.Goto(u, 45*time.Second); err != nil {
			p.Close()
			return nil, err
		}
	}
	return p, nil
}

// ---- the headless browser ----

type Browser struct {
	ctx         context.Context
	allocCancel context.CancelFunc
	cancel      context.CancelFunc
	dir         string
	closed      chan struct{}
}

var (
	hlMu sync.Mutex
	hl   *Browser
)

func browserPath(channel string) string {
	if p := os.Getenv("RA_BROWSER_PATH"); p != "" {
		return p
	}
	var cands []string
	pf := os.Getenv("ProgramFiles")
	pf86 := os.Getenv("ProgramFiles(x86)")
	local := os.Getenv("LOCALAPPDATA")
	if channel == "chrome" {
		switch goruntime.GOOS {
		case "windows":
			cands = []string{filepath.Join(pf, `Google\Chrome\Application\chrome.exe`), filepath.Join(pf86, `Google\Chrome\Application\chrome.exe`), filepath.Join(local, `Google\Chrome\Application\chrome.exe`)}
		case "darwin":
			cands = []string{"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
		default:
			cands = []string{"/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"}
		}
	} else {
		switch goruntime.GOOS {
		case "windows":
			cands = []string{filepath.Join(pf86, `Microsoft\Edge\Application\msedge.exe`), filepath.Join(pf, `Microsoft\Edge\Application\msedge.exe`)}
		case "darwin":
			cands = []string{"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"}
		default:
			cands = []string{"/opt/microsoft/msedge/msedge", "/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"}
		}
	}
	for _, c := range cands {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	return ""
}

func getHeadless() (*Browser, error) {
	hlMu.Lock()
	defer hlMu.Unlock()
	if hl != nil {
		select {
		case <-hl.closed:
			hl = nil
		default:
			return hl, nil
		}
	}
	channel := GetSettings().BrowserChannel
	exe := browserPath(channel)
	if exe == "" {
		which := "Edge"
		if channel == "chrome" {
			which = "Chrome"
		}
		return nil, errors.New("这台电脑上找不到 " + which + "。")
	}
	dir := filepath.Join(DataDir, "browser", fmt.Sprintf("headless-%d-%d", os.Getpid(), time.Now().UnixMilli()))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath(exe),
		chromedp.UserDataDir(dir),
		chromedp.WindowSize(1280, 720),
		// One process for every frame, so iframes (embedded application forms) are reachable from the page.
		chromedp.Flag("disable-site-isolation-trials", true),
		chromedp.Flag("disable-features", "IsolateOrigins,site-per-process,Translate"),
		chromedp.Flag("hide-scrollbars", true),
		chromedp.Flag("mute-audio", true),
	)
	allocCtx, allocCancel := chromedp.NewExecAllocator(context.Background(), opts...)
	ctx, cancel := chromedp.NewContext(allocCtx)
	if err := chromedp.Do(ctx); err != nil {
		cancel()
		allocCancel()
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("启动无头浏览器失败：%v", err)
	}
	b := &Browser{ctx: ctx, allocCancel: allocCancel, cancel: cancel, dir: dir, closed: make(chan struct{})}
	go func() {
		<-ctx.Done()
		close(b.closed)
		hlMu.Lock()
		if hl == b {
			hl = nil
		}
		hlMu.Unlock()
		if agentHeadless() {
			fireBrowserClosed()
			emit("browser")
		}
	}()
	hl = b
	return b, nil
}

func (b *Browser) close() {
	_ = chromedp.Cancel(b.ctx)
	b.cancel()
	b.allocCancel()
	for i := 0; i < 20; i++ {
		if os.RemoveAll(b.dir) == nil {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	parent := filepath.Dir(b.dir)
	_ = os.Remove(parent) // only when empty
}

// closeAll closes the headless browser (and with it any agent tabs opened there by the dev switch).
func closeAll() {
	hlMu.Lock()
	b := hl
	hl = nil
	hlMu.Unlock()
	if b != nil {
		b.close()
	}
}

// ---- pages ----

type pageOpts struct{ locale string }

type Page struct {
	b      *Browser
	ctx    context.Context
	cancel context.CancelFunc
	t      *chromedp.Target
	id     target.ID

	mu          sync.Mutex
	worlds      map[string]runtime.ExecutionContextID // frame id -> default world
	uniques     map[string]string                     // context unique id -> frame id
	mainFrame   string
	url         string
	closed      bool
	closedCh    chan struct{}
	onPopup     []func(*Page)
	onClose     []func()
	choosers    chan int64 // backend node ids of file choosers
	mouseX      float64
	mouseY      float64
	prefixes    map[string]string // frame id -> data-ra-id prefix
	popupsSeen  map[target.ID]bool
}

var frameSeq struct {
	sync.Mutex
	n int
}

func (b *Browser) NewPage(o pageOpts) (*Page, error) {
	p := &Page{b: b, worlds: map[string]runtime.ExecutionContextID{}, uniques: map[string]string{}, closedCh: make(chan struct{}), choosers: make(chan int64, 4), prefixes: map[string]string{}, popupsSeen: map[target.ID]bool{}}
	ctx, cancel := chromedp.NewContext(b.ctx, chromedp.WithNewBrowserContext(), chromedp.WithListener(p.onEvent))
	if err := p.attach(ctx, cancel); err != nil {
		return nil, err
	}
	call := func(m string, params any) { _ = p.call(m, params, nil) }
	call("Emulation.setDeviceMetricsOverride", map[string]any{"width": 1280, "height": 720, "deviceScaleFactor": 1, "mobile": false})
	if o.locale != "" {
		call("Emulation.setLocaleOverride", map[string]any{"locale": o.locale})
		call("Network.setExtraHTTPHeaders", map[string]any{"headers": map[string]string{"Accept-Language": o.locale}})
	}
	return p, nil
}

func (p *Page) attach(ctx context.Context, cancel context.CancelFunc) error {
	if err := chromedp.Do(ctx); err != nil {
		cancel()
		return err
	}
	c := chromedp.FromContext(ctx)
	p.ctx, p.cancel, p.t, p.id = ctx, cancel, c.Target, c.Target.TargetID
	var tree struct {
		FrameTree struct {
			Frame struct {
				ID  string `json:"id"`
				URL string `json:"url"`
			} `json:"frame"`
		} `json:"frameTree"`
	}
	if err := p.call("Page.getFrameTree", nil, &tree); err == nil {
		p.mu.Lock()
		p.mainFrame = tree.FrameTree.Frame.ID
		if p.url == "" {
			p.url = tree.FrameTree.Frame.URL
		}
		p.mu.Unlock()
	}
	go func() {
		<-ctx.Done()
		p.markClosed()
	}()
	return nil
}

func (p *Page) markClosed() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	close(p.closedCh)
	fns := p.onClose
	p.mu.Unlock()
	for _, fn := range fns {
		safely("page close", fn)
	}
}

// onEvent runs on the target's event loop: it must not block or call the browser itself.
func (p *Page) onEvent(ev any) {
	switch e := ev.(type) {
	case *runtime.EventExecutionContextCreated:
		var aux struct {
			IsDefault bool   `json:"isDefault"`
			FrameID   string `json:"frameId"`
		}
		_ = json.Unmarshal([]byte(e.Context.AuxData), &aux)
		if aux.IsDefault && aux.FrameID != "" {
			p.mu.Lock()
			p.worlds[aux.FrameID] = e.Context.ID
			p.uniques[e.Context.UniqueID] = aux.FrameID
			p.mu.Unlock()
		}
	case *runtime.EventExecutionContextDestroyed:
		p.mu.Lock()
		if f, ok := p.uniques[e.ExecutionContextUniqueID]; ok {
			delete(p.uniques, e.ExecutionContextUniqueID)
			delete(p.worlds, f)
		}
		p.mu.Unlock()
	case *runtime.EventExecutionContextsCleared:
		p.mu.Lock()
		p.worlds = map[string]runtime.ExecutionContextID{}
		p.uniques = map[string]string{}
		p.mu.Unlock()
	case *page.EventFrameNavigated:
		if e.Frame != nil && e.Frame.ParentID == "" {
			p.mu.Lock()
			p.mainFrame = string(e.Frame.ID)
			p.url = e.Frame.URL + e.Frame.URLFragment
			p.mu.Unlock()
		}
	case *page.EventNavigatedWithinDocument:
		p.mu.Lock()
		if string(e.FrameID) == p.mainFrame {
			p.url = e.URL
		}
		p.mu.Unlock()
	case *page.EventFrameDetached:
		p.mu.Lock()
		delete(p.worlds, string(e.FrameID))
		p.mu.Unlock()
	case *page.EventFileChooserOpened:
		select {
		case p.choosers <- int64(e.BackendNodeID):
		default:
		}
	case *page.EventJavascriptDialogOpening:
		// Playwright dismisses dialogs nobody listens for; an open dialog would block the page.
		go func() { _ = p.call("Page.handleJavaScriptDialog", map[string]any{"accept": false}, nil) }()
	case *inspector.EventDetached:
		go p.markClosed()
	case *target.EventTargetDestroyed:
		if e.TargetID == p.id {
			go p.markClosed()
		}
	case *target.EventTargetCreated:
		info := e.TargetInfo
		if info != nil && info.OpenerID == p.id && info.Type == "page" {
			p.mu.Lock()
			seen := p.popupsSeen[info.TargetID]
			p.popupsSeen[info.TargetID] = true
			handlers := len(p.onPopup) > 0
			p.mu.Unlock()
			if !seen && handlers {
				go p.adoptPopup(info.TargetID)
			}
		}
	}
}

func (p *Page) adoptPopup(id target.ID) {
	np := &Page{b: p.b, worlds: map[string]runtime.ExecutionContextID{}, uniques: map[string]string{}, closedCh: make(chan struct{}), choosers: make(chan int64, 4), prefixes: map[string]string{}, popupsSeen: map[target.ID]bool{}}
	ctx, cancel := chromedp.NewContext(p.b.ctx, chromedp.WithTargetID(id), chromedp.WithListener(np.onEvent))
	if err := np.attach(ctx, cancel); err != nil {
		return
	}
	_ = np.call("Emulation.setDeviceMetricsOverride", map[string]any{"width": 1280, "height": 720, "deviceScaleFactor": 1, "mobile": false}, nil)
	p.mu.Lock()
	fns := append([]func(*Page){}, p.onPopup...)
	p.mu.Unlock()
	for _, fn := range fns {
		safely("popup", func() { fn(np) })
	}
}

// OnPopup / OnClose register handlers (Playwright's page.on("popup") / page.on("close")).
func (p *Page) OnPopup(fn func(*Page)) {
	p.mu.Lock()
	p.onPopup = append(p.onPopup, fn)
	p.mu.Unlock()
}

func (p *Page) OnClose(fn func()) {
	p.mu.Lock()
	closed := p.closed
	if !closed {
		p.onClose = append(p.onClose, fn)
	}
	p.mu.Unlock()
	if closed {
		fn()
	}
}

func (p *Page) IsClosed() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.closed
}

func (p *Page) Close() {
	if p == nil || p.cancel == nil {
		return
	}
	p.cancel()
	p.markClosed()
}

func (p *Page) URL() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.url
}

func (p *Page) call(method string, params, res any) error {
	return p.callT(15*time.Second, method, params, res)
}

func (p *Page) callT(d time.Duration, method string, params, res any) error {
	if p.IsClosed() {
		return errors.New("Target page, context or browser has been closed")
	}
	ctx, cancel := context.WithTimeout(p.ctx, d)
	defer cancel()
	if params == nil {
		params = map[string]any{}
	}
	err := p.t.Call(ctx, method, params, res)
	if err != nil && errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%s timed out after %v", method, d)
	}
	return err
}

func (p *Page) BringToFront() { _ = p.call("Page.bringToFront", nil, nil) }

// ---- navigation and frames ----

func (p *Page) Goto(u string, timeout time.Duration) error {
	var res struct {
		FrameID   string `json:"frameId"`
		LoaderID  string `json:"loaderId"`
		ErrorText string `json:"errorText"`
	}
	if err := p.callT(timeout, "Page.navigate", map[string]any{"url": u}, &res); err != nil {
		return err
	}
	if res.ErrorText != "" {
		return fmt.Errorf("page.goto: %s at %s", res.ErrorText, u)
	}
	return p.WaitDOMContentLoaded(timeout)
}

// WaitDOMContentLoaded waits until the main frame's document is past "loading".
func (p *Page) WaitDOMContentLoaded(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		var st string
		if err := p.evalCtx("", `document.readyState`, &st, 3*time.Second); err == nil && st != "" && st != "loading" {
			return nil
		}
		if p.IsClosed() {
			return errors.New("page closed")
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("waiting for domcontentloaded timed out after %v", timeout)
		}
		time.Sleep(150 * time.Millisecond)
	}
}

// waitLoad waits for readyState "complete" and the fonts (setContent's waitUntil "load").
func (p *Page) waitLoad(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		var ok bool
		if err := p.evalCtx("", `document.readyState === "complete" ? document.fonts.ready.then(() => true) : false`, &ok, 5*time.Second); err == nil && ok {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("waiting for load timed out after %v", timeout)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (p *Page) SetContent(html string) error {
	p.mu.Lock()
	main := p.mainFrame
	p.mu.Unlock()
	if err := p.call("Page.setDocumentContent", map[string]any{"frameId": main, "html": html}, nil); err != nil {
		return err
	}
	return p.waitLoad(30 * time.Second)
}

type FrameInfo struct {
	ID   string
	URL  string
	Main bool
}

// Frames lists the page's frames, main frame first, children depth first (Playwright's page.frames()).
func (p *Page) Frames() []FrameInfo {
	type node struct {
		Frame struct {
			ID  string `json:"id"`
			URL string `json:"url"`
		} `json:"frame"`
		ChildFrames []json.RawMessage `json:"childFrames"`
	}
	var res struct {
		FrameTree json.RawMessage `json:"frameTree"`
	}
	if err := p.call("Page.getFrameTree", nil, &res); err != nil {
		return nil
	}
	out := []FrameInfo{}
	var walk func(raw json.RawMessage, main bool)
	walk = func(raw json.RawMessage, main bool) {
		var n node
		if json.Unmarshal(raw, &n) != nil {
			return
		}
		out = append(out, FrameInfo{ID: n.Frame.ID, URL: n.Frame.URL, Main: main})
		for _, c := range n.ChildFrames {
			walk(c, false)
		}
	}
	walk(res.FrameTree, true)
	if len(out) > 0 {
		p.mu.Lock()
		p.mainFrame = out[0].ID
		p.mu.Unlock()
	}
	return out
}

// framePrefix is the data-ra-id prefix of a frame ("f0_", "f1_", …), stable for the frame's life.
func (p *Page) framePrefix(frameID string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if v, ok := p.prefixes[frameID]; ok {
		return v
	}
	frameSeq.Lock()
	v := fmt.Sprintf("f%d_", frameSeq.n)
	frameSeq.n++
	frameSeq.Unlock()
	p.prefixes[frameID] = v
	return v
}

func (p *Page) frameOfPrefix(prefix string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	for f, v := range p.prefixes {
		if v == prefix {
			return f
		}
	}
	return ""
}

// FrameBox is the size of the <iframe> element that holds a child frame.
func (p *Page) FrameBox(frameID string) (w, h float64, ok bool) {
	var owner struct {
		BackendNodeID int64 `json:"backendNodeId"`
	}
	if err := p.call("DOM.getFrameOwner", map[string]any{"frameId": frameID}, &owner); err != nil {
		return 0, 0, false
	}
	var box struct {
		Model struct {
			Width  float64 `json:"width"`
			Height float64 `json:"height"`
		} `json:"model"`
	}
	if err := p.call("DOM.getBoxModel", map[string]any{"backendNodeId": owner.BackendNodeID}, &box); err != nil {
		return 0, 0, false
	}
	return box.Model.Width, box.Model.Height, true
}

// ---- evaluation ----

type remoteObject struct {
	Type     string          `json:"type"`
	Subtype  string          `json:"subtype"`
	Value    json.RawMessage `json:"value"`
	ObjectID string          `json:"objectId"`
}

type evalResult struct {
	Result           remoteObject `json:"result"`
	ExceptionDetails *struct {
		Text      string `json:"text"`
		Exception *struct {
			Description string `json:"description"`
		} `json:"exception"`
	} `json:"exceptionDetails"`
}

func (r evalResult) err() error {
	if r.ExceptionDetails == nil {
		return nil
	}
	msg := r.ExceptionDetails.Text
	if r.ExceptionDetails.Exception != nil && r.ExceptionDetails.Exception.Description != "" {
		msg = r.ExceptionDetails.Exception.Description
	}
	return errors.New(strings.SplitN(msg, "\n", 2)[0])
}

// world waits briefly for a frame's default execution context ("" = main frame).
func (p *Page) world(frameID string) (runtime.ExecutionContextID, error) {
	deadline := time.Now().Add(3 * time.Second)
	for {
		p.mu.Lock()
		if frameID == "" {
			frameID = p.mainFrame
		}
		id, ok := p.worlds[frameID]
		closed := p.closed
		p.mu.Unlock()
		if ok {
			return id, nil
		}
		if closed {
			return 0, errors.New("page closed")
		}
		if time.Now().After(deadline) {
			return 0, errors.New("frame has no execution context (detached or navigating)")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func decodeValue(r remoteObject, out any) error {
	if out == nil {
		return nil
	}
	if len(r.Value) == 0 || r.Type == "undefined" {
		return json.Unmarshal([]byte("null"), out)
	}
	return json.Unmarshal(r.Value, out)
}

func (p *Page) evalCtx(frameID, expr string, out any, d time.Duration) error {
	ctxID, err := p.world(frameID)
	if err != nil {
		return err
	}
	var res evalResult
	if err := p.callT(d, "Runtime.evaluate", map[string]any{"expression": expr, "contextId": ctxID, "returnByValue": true, "awaitPromise": true}, &res); err != nil {
		return err
	}
	if err := res.err(); err != nil {
		return err
	}
	return decodeValue(res.Result, out)
}

// Eval runs an expression in the main frame and decodes its JSON value into out.
func (p *Page) Eval(expr string, out any) error { return p.evalCtx("", expr, out, 30*time.Second) }

// EvalIn runs an expression in a frame.
func (p *Page) EvalIn(frameID, expr string, out any) error {
	return p.evalCtx(frameID, expr, out, 30*time.Second)
}

func (p *Page) Title() string {
	var t string
	_ = p.Eval(`document.title`, &t)
	return t
}

// ---- screenshots and PDF ----

func (p *Page) Screenshot(path string, fullPage bool, quality int, timeout time.Duration) error {
	params := map[string]any{"format": "jpeg", "quality": quality}
	if fullPage {
		var m struct {
			CSSContentSize struct {
				Width  float64 `json:"width"`
				Height float64 `json:"height"`
			} `json:"cssContentSize"`
		}
		if err := p.callT(timeout, "Page.getLayoutMetrics", nil, &m); err != nil {
			return err
		}
		w := math.Ceil(m.CSSContentSize.Width)
		h := math.Min(math.Ceil(m.CSSContentSize.Height), 16384)
		params["captureBeyondViewport"] = true
		params["clip"] = map[string]any{"x": 0, "y": 0, "width": w, "height": h, "scale": 1}
	}
	var res struct {
		Data string `json:"data"`
	}
	if err := p.callT(timeout, "Page.captureScreenshot", params, &res); err != nil {
		return err
	}
	b, err := base64.StdEncoding.DecodeString(res.Data)
	if err != nil {
		return err
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	return os.WriteFile(path, b, 0o644)
}

func (p *Page) EmulatePrint() error {
	return p.call("Emulation.setEmulatedMedia", map[string]any{"media": "print"}, nil)
}

func (p *Page) PrintPDF(path string) error {
	var res struct {
		Data string `json:"data"`
	}
	params := map[string]any{"preferCSSPageSize": true, "printBackground": true, "marginTop": 0, "marginBottom": 0, "marginLeft": 0, "marginRight": 0, "paperWidth": 8.5, "paperHeight": 11}
	if err := p.callT(60*time.Second, "Page.printToPDF", params, &res); err != nil {
		return err
	}
	b, err := base64.StdEncoding.DecodeString(res.Data)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

// ---- input ----

func (p *Page) mouse(typ string, x, y float64, extra map[string]any) error {
	params := map[string]any{"type": typ, "x": x, "y": y}
	for k, v := range extra {
		params[k] = v
	}
	return p.call("Input.dispatchMouseEvent", params, nil)
}

func (p *Page) clickAt(x, y float64) error {
	if err := p.mouse("mouseMoved", x, y, nil); err != nil {
		return err
	}
	p.mu.Lock()
	p.mouseX, p.mouseY = x, y
	p.mu.Unlock()
	if err := p.mouse("mousePressed", x, y, map[string]any{"button": "left", "buttons": 1, "clickCount": 1}); err != nil {
		return err
	}
	return p.mouse("mouseReleased", x, y, map[string]any{"button": "left", "buttons": 0, "clickCount": 1})
}

// MouseWheel scrolls whatever is under the mouse.
func (p *Page) MouseWheel(dy float64) error {
	p.mu.Lock()
	x, y := p.mouseX, p.mouseY
	p.mu.Unlock()
	return p.mouse("mouseWheel", x, y, map[string]any{"deltaX": 0, "deltaY": dy})
}

func (p *Page) insertText(s string) error {
	return p.call("Input.insertText", map[string]any{"text": s}, nil)
}

func (p *Page) pressKey(key, code string, vk int) error {
	if err := p.call("Input.dispatchKeyEvent", map[string]any{"type": "rawKeyDown", "key": key, "code": code, "windowsVirtualKeyCode": vk}, nil); err != nil {
		return err
	}
	return p.call("Input.dispatchKeyEvent", map[string]any{"type": "keyUp", "key": key, "code": code, "windowsVirtualKeyCode": vk}, nil)
}

func (p *Page) typeChar(ch string) error {
	if err := p.call("Input.dispatchKeyEvent", map[string]any{"type": "keyDown", "key": ch, "text": ch, "unmodifiedText": ch}, nil); err != nil {
		return err
	}
	return p.call("Input.dispatchKeyEvent", map[string]any{"type": "keyUp", "key": ch}, nil)
}

// ---- locators ----

// Locator finds the first element matching a CSS selector in one frame, open shadow roots included.
type Locator struct {
	p     *Page
	frame string
	sel   string
}

func (p *Page) Locator(frameID, sel string) *Locator { return &Locator{p: p, frame: frameID, sel: sel} }

const deepQuery = `(sel) => {
  const roots = [document];
  while (roots.length) {
    const r = roots.shift();
    const hit = r.querySelector(sel);
    if (hit) return hit;
    for (const el of r.querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
  }
  return null;
}`

// resolve returns the element's object id, waiting up to timeout for it to exist.
func (l *Locator) resolve(timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)
	for {
		ctxID, err := l.p.world(l.frame)
		if err == nil {
			var res evalResult
			err = l.p.call("Runtime.evaluate", map[string]any{"expression": "(" + deepQuery + ")(" + jsonStr(l.sel) + ")", "contextId": ctxID}, &res)
			if err == nil {
				err = res.err()
			}
			if err == nil && res.Result.ObjectID != "" && res.Result.Subtype != "null" {
				return res.Result.ObjectID, nil
			}
		}
		if l.p.IsClosed() {
			return "", errors.New("Target page, context or browser has been closed")
		}
		if time.Now().After(deadline) {
			return "", fmt.Errorf("locator %s: element not found within %v", l.sel, timeout)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (l *Locator) callOn(objID, fn string, args []any, out any) error {
	a := []map[string]any{}
	for _, v := range args {
		a = append(a, map[string]any{"value": v})
	}
	var res evalResult
	if err := l.p.call("Runtime.callFunctionOn", map[string]any{"objectId": objID, "functionDeclaration": fn, "arguments": a, "returnByValue": true, "awaitPromise": true}, &res); err != nil {
		return err
	}
	if err := res.err(); err != nil {
		return err
	}
	return decodeValue(res.Result, out)
}

// Evaluate calls fn (a JS function taking the element and optional args) and decodes the result.
func (l *Locator) Evaluate(fn string, out any, args ...any) error {
	obj, err := l.resolve(5 * time.Second)
	if err != nil {
		return err
	}
	return l.callOn(obj, "function(...a) { return ("+fn+")(this, ...a); }", args, out)
}

// clickable waits for the element to be visible and enabled and returns a point inside it.
func (l *Locator) clickable(timeout time.Duration) (string, float64, float64, error) {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for {
		obj, err := l.resolve(time.Until(deadline))
		if err != nil {
			return "", 0, 0, err
		}
		var st struct {
			Visible  bool `json:"visible"`
			Disabled bool `json:"disabled"`
		}
		err = l.callOn(obj, `function() {
  const r = this.getBoundingClientRect();
  const cs = getComputedStyle(this);
  return { visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden", disabled: !!this.disabled || this.getAttribute("aria-disabled") === "true" };
}`, nil, &st)
		if err == nil && st.Visible && !st.Disabled {
			_ = l.p.call("DOM.scrollIntoViewIfNeeded", map[string]any{"objectId": obj}, nil)
			var q struct {
				Quads [][]float64 `json:"quads"`
			}
			if err := l.p.call("DOM.getContentQuads", map[string]any{"objectId": obj}, &q); err == nil {
				for _, quad := range q.Quads {
					if len(quad) < 8 {
						continue
					}
					x := (quad[0] + quad[2] + quad[4] + quad[6]) / 4
					y := (quad[1] + quad[3] + quad[5] + quad[7]) / 4
					area := math.Abs((quad[2]-quad[0])*(quad[5]-quad[1]) - (quad[4]-quad[0])*(quad[3]-quad[1]))
					if area > 0.99 {
						return obj, x, y, nil
					}
				}
			}
			lastErr = errors.New("element has no visible area")
		} else if err != nil {
			lastErr = err
		} else if !st.Visible {
			lastErr = errors.New("element is not visible")
		} else {
			lastErr = errors.New("element is not enabled")
		}
		if time.Now().After(deadline) {
			return "", 0, 0, fmt.Errorf("locator.click: timeout %v exceeded: %v", timeout, lastErr)
		}
		time.Sleep(120 * time.Millisecond)
	}
}

// Click clicks the middle of the element with the mouse; if something else would receive the
// click there (an overlay), it waits, and in the end clicks it from script.
func (l *Locator) Click(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		obj, x, y, err := l.clickable(time.Until(deadline))
		if err != nil {
			return err
		}
		hit := true
		if l.frame == "" || l.frame == l.p.mainFrameID() {
			_ = l.callOn(obj, `function(x, y) {
  let e = document.elementFromPoint(x, y);
  while (e && e.shadowRoot) { const inner = e.shadowRoot.elementFromPoint(x, y); if (!inner || inner === e) break; e = inner; }
  if (!e) return false;
  if (e === this || this.contains(e)) return true;
  const label = e.closest("label");
  if (label && (label.control === this || label.contains(this))) return true;
  return false;
}`, []any{x, y}, &hit)
		}
		if hit {
			return l.p.clickAt(x, y)
		}
		if time.Now().After(deadline) {
			return l.callOn(obj, `function() { this.click(); }`, nil, nil)
		}
		time.Sleep(150 * time.Millisecond)
	}
}

func (p *Page) mainFrameID() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.mainFrame
}

// Fill replaces the field's value like Playwright's fill.
func (l *Locator) Fill(value string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		obj, err := l.resolve(time.Until(deadline))
		if err != nil {
			return err
		}
		var kind string
		err = l.callOn(obj, `function(value) {
  const el = this;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0) || getComputedStyle(el).visibility === "hidden") return "hidden";
  if (el.disabled || el.readOnly) return "readonly";
  const tag = el.tagName;
  if (tag === "INPUT") {
    const t = (el.type || "text").toLowerCase();
    if (["checkbox", "radio", "file", "button", "submit", "reset", "image"].includes(t)) return "error:Input of type \"" + t + "\" cannot be filled";
    if (["date", "time", "datetime-local", "month", "week", "range", "color"].includes(t)) {
      el.focus();
      el.value = value;
      if (el.value !== value) return "error:Malformed value";
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return "done";
    }
    el.focus();
    el.select();
    return "type";
  }
  if (tag === "TEXTAREA") { el.focus(); el.select(); return "type"; }
  if (el.isContentEditable) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return "type";
  }
  return "error:Element is not an <input>, <textarea> or [contenteditable] element";
}`, []any{value}, &kind)
		if err != nil {
			return err
		}
		switch {
		case kind == "done":
			return nil
		case strings.HasPrefix(kind, "error:"):
			return errors.New("locator.fill: " + strings.TrimPrefix(kind, "error:"))
		case kind == "type":
			if value == "" {
				return l.p.pressKey("Delete", "Delete", 46)
			}
			return l.p.insertText(value)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("locator.fill: timeout %v exceeded: element is %s", timeout, kind)
		}
		time.Sleep(120 * time.Millisecond)
	}
}

// PressSequentially focuses the element and types the text one key at a time.
func (l *Locator) PressSequentially(text string, delay time.Duration, timeout time.Duration) error {
	obj, err := l.resolve(timeout)
	if err != nil {
		return err
	}
	if err := l.callOn(obj, `function() { this.focus(); }`, nil, nil); err != nil {
		return err
	}
	for _, r := range text {
		if err := l.p.typeChar(string(r)); err != nil {
			return err
		}
		time.Sleep(delay)
	}
	return nil
}

// SelectOption selects the option with this value and fires input and change.
func (l *Locator) SelectOption(value string, timeout time.Duration) error {
	obj, err := l.resolve(timeout)
	if err != nil {
		return err
	}
	var res string
	if err := l.callOn(obj, `function(value) {
  if (this.tagName !== "SELECT") return "Element is not a <select> element";
  const opt = Array.from(this.options).find((o) => o.value === value);
  if (!opt) return "no option with value " + JSON.stringify(value);
  if (this.disabled) return "element is disabled";
  this.focus();
  for (const o of this.options) o.selected = o === opt;
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return "";
}`, []any{value}, &res); err != nil {
		return err
	}
	if res != "" {
		return errors.New("locator.selectOption: " + res)
	}
	return nil
}

const checkedStateJS = `function() {
  const el = this;
  if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) return el.checked ? "true" : "false";
  const role = el.getAttribute("role");
  if (["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio", "option"].includes(role)) return el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true" ? "true" : "false";
  return "error";
}`

// IsChecked reads a checkbox or radio's state.
func (l *Locator) IsChecked() (bool, error) {
	obj, err := l.resolve(3 * time.Second)
	if err != nil {
		return false, err
	}
	var st string
	if err := l.callOn(obj, checkedStateJS, nil, &st); err != nil {
		return false, err
	}
	if st == "error" {
		return false, errors.New("Not a checkbox or radio button")
	}
	return st == "true", nil
}

// SetChecked clicks the element when its state differs, then checks that the click took.
func (l *Locator) SetChecked(want bool, timeout time.Duration) error {
	now, err := l.IsChecked()
	if err != nil {
		return err
	}
	if now == want {
		return nil
	}
	if !want {
		var radio bool
		_ = l.Evaluate(`(e) => e.type === "radio" || e.getAttribute("role") === "radio"`, &radio)
		if radio {
			return errors.New("Cannot uncheck radio button")
		}
	}
	if err := l.Click(timeout); err != nil {
		return err
	}
	if now, err = l.IsChecked(); err != nil {
		return err
	}
	if now != want {
		return errors.New("Clicking the checkbox did not change its state")
	}
	return nil
}

const setFilesJS = `function(name, mime, b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], name, { type: mime, lastModified: Date.now() }));
  this.files = dt.files;
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return "";
}`

// SetInputFiles hands the page a file built from bytes (no path goes over CDP).
func (l *Locator) SetInputFiles(name, mime string, data []byte, timeout time.Duration) error {
	obj, err := l.resolve(timeout)
	if err != nil {
		return err
	}
	var isFile bool
	_ = l.callOn(obj, `function() { return this.tagName === "INPUT" && this.type === "file"; }`, nil, &isFile)
	if !isFile {
		return errors.New("locator.setInputFiles: Node is not an HTMLInputElement of type file")
	}
	return l.callOn(obj, setFilesJS, []any{name, mime, base64.StdEncoding.EncodeToString(data)}, nil)
}

// UploadThroughChooser clicks an upload button and gives the file chooser it opens the file.
func (l *Locator) UploadThroughChooser(name, mime string, data []byte, timeout time.Duration) error {
	p := l.p
	for len(p.choosers) > 0 {
		<-p.choosers
	}
	if err := p.call("Page.setInterceptFileChooserDialog", map[string]any{"enabled": true}, nil); err != nil {
		return err
	}
	defer func() { _ = p.call("Page.setInterceptFileChooserDialog", map[string]any{"enabled": false}, nil) }()
	if err := l.Click(timeout); err != nil {
		return err
	}
	var node int64
	select {
	case node = <-p.choosers:
	case <-time.After(timeout):
		return fmt.Errorf("waiting for event \"filechooser\": timeout %v exceeded", timeout)
	}
	var res struct {
		Object remoteObject `json:"object"`
	}
	if err := p.call("DOM.resolveNode", map[string]any{"backendNodeId": node}, &res); err != nil {
		return err
	}
	return l.callOn(res.Object.ObjectID, setFilesJS, []any{name, mime, base64.StdEncoding.EncodeToString(data)}, nil)
}
