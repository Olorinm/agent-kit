// Diagnostic bridge for a private test cluster only. Kubernetes' service proxy
// strips Authorization, including envd's Basic username header. This bridge
// restores the fixed test OS user; envd's per-sandbox access token is unchanged.
// Never expose this listener publicly. It is not a product authentication layer.
package main

import (
	"flag"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
)

func main() {
	listen := flag.String("listen", ":18080", "private test pod listener")
	target := flag.String("target", "", "E2B data-plane service URL")
	flag.Parse()
	u, err := url.Parse(*target)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		log.Fatal("an explicit HTTP(S) data-plane target is required")
	}
	proxy := &httputil.ReverseProxy{Rewrite: func(r *httputil.ProxyRequest) {
		r.SetURL(u)
		r.Out.SetBasicAuth("user", "")
	}, FlushInterval: -1}
	log.Fatal(http.ListenAndServe(*listen, proxy))
}
