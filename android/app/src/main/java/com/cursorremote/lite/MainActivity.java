package com.cursorremote.lite;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

// A thin WebView shell around the user's GitHub Pages app, so it installs without Google Play services or PWA support.
public class MainActivity extends Activity {
    private static final String SETUP = "file:///android_asset/setup.html";
    private WebView web;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("cursor-remote", MODE_PRIVATE);
        web = new WebView(this);
        web.setBackgroundColor(0xFF1E1E1E);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setUserAgentString(s.getUserAgentString() + " CursorRemoteApp/" + BuildConfigVersion.name(this));

        web.addJavascriptInterface(new Bridge(), "CursorRemoteApp");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("file".equals(u.getScheme()) || sameOrigin(u, appUrl())) return false;
                // Donate links etc. open in the system browser; the bridge is only exposed to the app's own pages.
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) view.loadUrl(SETUP + "?offline=1");
            }
        });

        if (state != null) web.restoreState(state);
        else load();
    }

    private String appUrl() {
        String saved = prefs.getString("url", null);
        return saved != null ? saved : getString(R.string.default_url);
    }

    private void load() {
        String url = appUrl();
        web.loadUrl(url.isEmpty() ? SETUP : url);
    }

    private static boolean sameOrigin(Uri u, String base) {
        if (base == null || base.isEmpty()) return false;
        Uri b = Uri.parse(base);
        return u.getScheme() != null && u.getScheme().equals(b.getScheme()) && u.getHost() != null && u.getHost().equals(b.getHost());
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    private class Bridge {
        @JavascriptInterface
        public String getUrl() {
            return appUrl();
        }

        @JavascriptInterface
        public void setUrl(String url) {
            prefs.edit().putString("url", url).apply();
            runOnUiThread(() -> { web.clearHistory(); web.loadUrl(url); });
        }

        @JavascriptInterface
        public void retry() {
            runOnUiThread(MainActivity.this::load);
        }

        @JavascriptInterface
        public void changeUrl() {
            runOnUiThread(() -> web.loadUrl(SETUP + "?change=1"));
        }
    }
}
