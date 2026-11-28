// Text layer of an imported PDF resume (profile.ts pdfText). The TS server runs pdf.js in Node; here the
// same pdf.js build runs in the headless browser, served from this server's own origin.
package app

import (
	"encoding/base64"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// ServerURL is where this server listens (set by main); the headless page loads pdf.js from it.
var ServerURL string

func pdfjsDir() string { return filepath.Join(Root, "node_modules", "pdfjs-dist", "legacy", "build") }

const pdfjsHost = `<!doctype html><meta charset="utf-8"><title>pdf</title>`

func servePdfjs(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("file")
	switch name {
	case "host.html":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(pdfjsHost))
	case "pdf.mjs", "pdf.worker.mjs":
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		http.ServeFile(w, r, filepath.Join(pdfjsDir(), name))
	default:
		http.NotFound(w, r)
	}
}

// Same line-joining as the TS version: a new line when y moves by more than 2 or an item ends a line.
const pdfTextJS = `(async (b64) => {
  const pdfjs = await import("/api/_pdfjs/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/api/_pdfjs/pdf.worker.mjs";
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const doc = await pdfjs.getDocument({ data: buf, useSystemFonts: true }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = "";
    const out = [];
    let lastY = null;
    for (const it of content.items) {
      const y = it.transform?.[5] ?? 0;
      if (lastY !== null && Math.abs(y - lastY) > 2 && line) {
        out.push(line);
        line = "";
      }
      line += it.str;
      lastY = y;
      if (it.hasEOL) {
        out.push(line);
        line = "";
        lastY = null;
      }
    }
    if (line) out.push(line);
    pages.push(out.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n"));
  }
  await doc.loadingTask.destroy();
  return pages.join("\n\n");
})`

func pdfText(buf []byte) (string, error) {
	if ServerURL == "" {
		return "", errors.New("PDF 导入不可用：服务器地址未知")
	}
	if _, err := os.Stat(filepath.Join(pdfjsDir(), "pdf.mjs")); err != nil {
		return "", errors.New("PDF 导入需要 node_modules/pdfjs-dist（先运行 pnpm install）")
	}
	b, err := getHeadless()
	if err != nil {
		return "", err
	}
	p, err := b.NewPage(pageOpts{})
	if err != nil {
		return "", err
	}
	defer p.Close()
	if err := p.Goto(ServerURL+"/api/_pdfjs/host.html", 30*time.Second); err != nil {
		return "", err
	}
	var text string
	if err := p.evalCtx("", pdfTextJS+"("+jsonStr(base64.StdEncoding.EncodeToString(buf))+")", &text, 60*time.Second); err != nil {
		return "", errors.New("读不了这个 PDF：" + err.Error())
	}
	return text, nil
}
