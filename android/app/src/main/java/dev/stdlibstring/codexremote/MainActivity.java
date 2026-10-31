package dev.stdlibstring.codexremote;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.appcompat.app.AppCompatActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.core.widget.NestedScrollView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.google.android.material.bottomsheet.BottomSheetBehavior;
import com.google.android.material.bottomsheet.BottomSheetDialog;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.progressindicator.LinearProgressIndicator;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Scanner;

public final class MainActivity extends AppCompatActivity {
    private WebView webView;
    private FrameLayout windowContent;
    private FrameLayout fullscreenContainer;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private LinearLayout root;
    private TextView toolbarTitle;
    private ImageButton refreshButton;
    private ImageButton moreButton;
    private NestedScrollView errorPanel;
    private ImageView errorIcon;
    private TextView errorTitle;
    private TextView errorDetail;
    private MaterialButton retryButton;
    private LinearProgressIndicator progress;
    private BottomSheetDialog menu;
    private View menuHandle;
    private final List<TextView> menuLabels = new ArrayList<>();
    private final List<TextView> menuDetails = new ArrayList<>();
    private final List<ImageView> menuIcons = new ArrayList<>();
    private boolean darkMode;
    private int surface;
    private int sheetSurface;
    private int foreground;
    private int secondary;
    private int muted;
    private ValueCallback<Uri[]> upload;
    private String currentUrl = BuildConfig.SERVER_URL;
    private boolean loadFailed;

    private final ActivityResultLauncher<Intent> chooser = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(), result -> {
                if (upload == null) return;
                upload.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.getResultCode(), result.getData()));
                upload = null;
            });

    @Override
    protected void onCreate(Bundle state) {
        darkMode = getPreferences(MODE_PRIVATE).getString("appearance", "dark").equals("dark");
        setTheme(darkMode ? R.style.Theme_CodexRemote : R.style.Theme_CodexRemote_Light);
        super.onCreate(state);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        windowContent = new FrameLayout(this);
        setContentView(windowContent);
        root = new LinearLayout(this);
        root.setId(R.id.codex_root);
        root.setOrientation(LinearLayout.VERTICAL);
        windowContent.addView(root, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        ViewCompat.setOnApplyWindowInsetsListener(windowContent, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets keyboard = insets.getInsets(WindowInsetsCompat.Type.ime());
            // 缩小 WebView 的实际布局高度，让嵌套的插件页面一起调整尺寸。
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            return WindowInsetsCompat.CONSUMED;
        });

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setId(R.id.codex_toolbar);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(20), 0, dp(8), 0);
        root.addView(toolbar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(56)));
        toolbarTitle = new TextView(this);
        toolbarTitle.setText(R.string.toolbar_title);
        toolbarTitle.setTextSize(20);
        toolbarTitle.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        toolbar.addView(toolbarTitle, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        refreshButton = toolbarButton(R.id.codex_refresh, R.drawable.ic_refresh, R.string.refresh);
        refreshButton.setOnClickListener(view -> reload());
        toolbar.addView(refreshButton, new LinearLayout.LayoutParams(dp(48), dp(48)));
        moreButton = toolbarButton(R.id.codex_more, R.drawable.ic_more, R.string.more);
        moreButton.setOnClickListener(view -> showMenu());
        toolbar.addView(moreButton, new LinearLayout.LayoutParams(dp(48), dp(48)));

        progress = new LinearProgressIndicator(this);
        progress.setTrackThickness(dp(2));
        progress.setTrackCornerRadius(0);
        progress.setTrackColor(Color.TRANSPARENT);
        progress.setMax(100);
        FrameLayout content = new FrameLayout(this);
        root.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        webView = new WebView(this) {
            @Override
            public InputConnection onCreateInputConnection(EditorInfo attributes) {
                InputConnection connection = super.onCreateInputConnection(attributes);
                // 允许输入法在横屏时提供系统编辑区域，保证文字始终能够编辑和选择。
                attributes.imeOptions &= ~(EditorInfo.IME_FLAG_NO_FULLSCREEN | EditorInfo.IME_FLAG_NO_EXTRACT_UI);
                return connection;
            }
        };
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        webView.setId(R.id.codex_webview);
        webView.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_YES);
        content.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        createErrorPanel(content);
        content.addView(progress, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2), Gravity.TOP));
        configureWebView();
        applyAppearance(darkMode);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(windowContent);
                if (insets != null && insets.isVisible(WindowInsetsCompat.Type.ime())) {
                    WindowCompat.getInsetsController(getWindow(), windowContent).hide(WindowInsetsCompat.Type.ime());
                } else if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
                else if (webView.canGoBack()) webView.goBack();
                else moveTaskToBack(true);
            }
        });
        if (state != null) currentUrl = state.getString("currentUrl", BuildConfig.SERVER_URL);
        ViewCompat.requestApplyInsets(windowContent);
        if (installAppearanceObserver()) webView.loadUrl(currentUrl);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " CodexRemote/" + BuildConfig.VERSION_NAME);
        settings.setAllowFileAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setTextZoom(100);
        settings.setSupportMultipleWindows(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                if (sameServer(request.getUrl())) return false;
                openExternal(request.getUrl());
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
                currentUrl = url;
                loadFailed = false;
                errorPanel.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
                progress.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                progress.setVisibility(View.GONE);
                view.evaluateJavascript("Boolean(window.CSS && CSS.supports('top', 'anchor(top)') && CSS.supports('width', 'anchor-size(width)'))", supported -> {
                    if (!"true".equals(supported)) showError(getString(R.string.webview_update), getString(R.string.webview_update_detail));
                });
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError(getString(R.string.network_error), getString(R.string.network_error_detail));
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) showError(getString(R.string.http_error, response.getStatusCode()), getString(R.string.network_error_detail));
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showError(getString(R.string.certificate_error), getString(R.string.certificate_error_detail));
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreenContainer != null) throw new IllegalStateException("全屏页面已经打开。");
                fullscreenCallback = callback;
                fullscreenContainer = new FrameLayout(MainActivity.this);
                fullscreenContainer.setId(R.id.codex_fullscreen);
                fullscreenContainer.setBackgroundColor(surface);
                fullscreenContainer.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                windowContent.addView(fullscreenContainer, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                root.setVisibility(View.GONE);
                enterImmersiveMode();
                ViewCompat.requestApplyInsets(windowContent);
            }

            @Override
            public void onHideCustomView() {
                hideFullscreen();
            }

            @Override
            public void onProgressChanged(WebView view, int value) {
                progress.setProgressCompat(value, true);
                progress.setVisibility(value == 100 || loadFailed ? View.GONE : View.VISIBLE);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams parameters) {
                if (upload != null) upload.onReceiveValue(null);
                upload = callback;
                chooser.launch(parameters.createIntent());
                return true;
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture, android.os.Message message) {
                if (!userGesture) return false;
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView child, WebResourceRequest request) {
                        openExternal(request.getUrl());
                        child.destroy();
                        return true;
                    }
                });
                ((WebView.WebViewTransport) message.obj).setWebView(popup);
                message.sendToTarget();
                return true;
            }
        });
    }

    private void enterImmersiveMode() {
        var controller = WindowCompat.getInsetsController(getWindow(), windowContent);
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }

    private void hideFullscreen() {
        if (fullscreenContainer == null) return;
        windowContent.removeView(fullscreenContainer);
        fullscreenContainer.removeAllViews();
        fullscreenContainer = null;
        fullscreenCallback = null;
        root.setVisibility(View.VISIBLE);
        WindowCompat.getInsetsController(getWindow(), windowContent).show(WindowInsetsCompat.Type.systemBars());
        ViewCompat.requestApplyInsets(windowContent);
    }

    private boolean installAppearanceObserver() {
        Uri server = Uri.parse(BuildConfig.SERVER_URL);
        var origins = Collections.singleton(server.getScheme() + "://" + server.getAuthority());
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "CodexAppearance", origins,
                    (view, message, origin, mainFrame, reply) -> {
                        if (!mainFrame) return;
                        switch (message.getData()) {
                            case "dark": applyAppearance(true); break;
                            case "light": applyAppearance(false); break;
                            default: throw new IllegalArgumentException("无法识别网页的主题设置。");
                        }
                    });
        } else {
            showError(getString(R.string.webview_update), getString(R.string.webview_update_detail));
            return false;
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            try (Scanner source = new Scanner(getResources().openRawResource(R.raw.appearance), "UTF-8")) {
                WebViewCompat.addDocumentStartJavaScript(webView, source.useDelimiter("\\A").next(), origins);
            }
        } else {
            showError(getString(R.string.webview_update), getString(R.string.webview_update_detail));
            return false;
        }
        return true;
    }

    private void applyAppearance(boolean dark) {
        darkMode = dark;
        getTheme().applyStyle(dark ? R.style.Theme_CodexRemote : R.style.Theme_CodexRemote_Light, true);
        surface = getColor(dark ? R.color.surface_dark : R.color.surface_light);
        sheetSurface = getColor(dark ? R.color.sheet_dark : R.color.sheet_light);
        foreground = getColor(dark ? R.color.text_dark : R.color.text_light);
        secondary = getColor(dark ? R.color.secondary_dark : R.color.secondary_light);
        muted = getColor(dark ? R.color.muted_dark : R.color.muted_light);
        windowContent.setBackgroundColor(surface);
        if (fullscreenContainer != null) fullscreenContainer.setBackgroundColor(surface);
        root.setBackgroundColor(surface);
        getWindow().getDecorView().setBackgroundColor(surface);
        webView.setBackgroundColor(surface);
        toolbarTitle.setTextColor(foreground);
        tintButton(refreshButton);
        tintButton(moreButton);
        progress.setIndicatorColor(foreground);
        errorIcon.setImageTintList(ColorStateList.valueOf(secondary));
        errorIcon.setBackground(rounded(muted, 36));
        errorTitle.setTextColor(foreground);
        errorDetail.setTextColor(secondary);
        errorPanel.setBackgroundColor(surface);
        retryButton.setBackgroundTintList(ColorStateList.valueOf(foreground));
        retryButton.setTextColor(surface);
        var controller = WindowCompat.getInsetsController(getWindow(), root);
        controller.setAppearanceLightStatusBars(!dark);
        controller.setAppearanceLightNavigationBars(!dark);
        tintMenu();
        getPreferences(MODE_PRIVATE).edit().putString("appearance", dark ? "dark" : "light").apply();
    }

    private GradientDrawable rounded(int color, int radius) {
        GradientDrawable background = new GradientDrawable();
        background.setColor(color);
        background.setCornerRadius(dp(radius));
        return background;
    }

    private RippleDrawable ripple(int radius) {
        return new RippleDrawable(ColorStateList.valueOf(darkMode ? 0x20FFFFFF : 0x14000000),
                null, rounded(Color.WHITE, radius));
    }

    private void tintButton(ImageButton button) {
        button.setImageTintList(ColorStateList.valueOf(foreground));
        button.setBackground(ripple(24));
    }

    private void createErrorPanel(FrameLayout content) {
        errorPanel = new NestedScrollView(this);
        errorPanel.setId(R.id.codex_error);
        errorPanel.setFillViewport(true);
        errorPanel.setVerticalScrollBarEnabled(false);
        errorPanel.setVisibility(View.GONE);
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setGravity(Gravity.CENTER);
        body.setPadding(dp(32), dp(24), dp(32), dp(24));
        errorPanel.addView(body, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        errorIcon = new ImageView(this);
        errorIcon.setImageResource(R.drawable.ic_connection);
        errorIcon.setPadding(dp(20), dp(20), dp(20), dp(20));
        body.addView(errorIcon, new LinearLayout.LayoutParams(dp(72), dp(72)));
        errorTitle = new TextView(this);
        errorTitle.setTextSize(20);
        errorTitle.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        errorTitle.setMaxWidth(dp(320));
        errorTitle.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams heading = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        heading.topMargin = dp(20);
        body.addView(errorTitle, heading);
        errorDetail = new TextView(this);
        errorDetail.setTextSize(14);
        errorDetail.setMaxWidth(dp(320));
        errorDetail.setLineSpacing(dp(5), 1);
        errorDetail.setGravity(Gravity.CENTER);
        errorDetail.setPadding(0, dp(10), 0, dp(24));
        body.addView(errorDetail);
        retryButton = new MaterialButton(this);
        retryButton.setId(R.id.codex_retry);
        retryButton.setText(R.string.retry);
        retryButton.setTextSize(14);
        retryButton.setAllCaps(false);
        retryButton.setCornerRadius(dp(24));
        retryButton.setInsetTop(0);
        retryButton.setInsetBottom(0);
        retryButton.setOnClickListener(view -> reload());
        body.addView(retryButton, new LinearLayout.LayoutParams(dp(156), dp(48)));
        content.addView(errorPanel, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private ImageButton toolbarButton(int id, int icon, int description) {
        ImageButton button = new ImageButton(this, null, 0);
        button.setId(id);
        button.setImageResource(icon);
        button.setContentDescription(getString(description));
        button.setTooltipText(getString(description));
        button.setPadding(dp(12), dp(12), dp(12), dp(12));
        button.setScaleType(ImageView.ScaleType.CENTER);
        tintButton(button);
        return button;
    }

    private void showMenu() {
        if (menu != null) {
            menu.dismiss();
            return;
        }
        WindowCompat.getInsetsController(getWindow(), root).hide(WindowInsetsCompat.Type.ime());
        menu = new BottomSheetDialog(this);
        menu.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN
                | WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        menu.setDismissWithAnimation(true);
        menu.setCanceledOnTouchOutside(true);
        LinearLayout body = new LinearLayout(this);
        body.setId(R.id.codex_menu);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(12), dp(10), dp(12), dp(24));
        menuHandle = new View(this);
        LinearLayout.LayoutParams handle = new LinearLayout.LayoutParams(dp(32), dp(4));
        handle.gravity = Gravity.CENTER_HORIZONTAL;
        handle.bottomMargin = dp(12);
        body.addView(menuHandle, handle);

        LinearLayout heading = new LinearLayout(this);
        heading.setGravity(Gravity.CENTER_VERTICAL);
        heading.setPadding(dp(12), 0, 0, dp(8));
        TextView title = new TextView(this);
        title.setText(R.string.menu_title);
        title.setTextSize(20);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        menuLabels.add(title);
        heading.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));
        title.setGravity(Gravity.CENTER_VERTICAL);
        ImageButton close = toolbarButton(R.id.codex_menu_close, R.drawable.ic_close, R.string.close_menu);
        close.setOnClickListener(view -> menu.dismiss());
        menuIcons.add(close);
        heading.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));
        body.addView(heading);
        body.addView(menuRow(R.id.codex_account, R.drawable.ic_account, R.string.account, R.string.account_detail, () -> {
            menu.dismiss();
            webView.loadUrl(BuildConfig.SERVER_URL + "?manage=1");
        }));
        body.addView(menuRow(R.id.codex_browser, R.drawable.ic_external, R.string.browser, R.string.browser_detail, () -> {
            menu.dismiss();
            openExternal(Uri.parse(currentUrl));
        }));
        NestedScrollView scroll = new NestedScrollView(this);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.addView(body);
        menu.setContentView(scroll);
        menu.setOnShowListener(dialog -> {
            menu.getBehavior().setSkipCollapsed(true);
            menu.getBehavior().setState(BottomSheetBehavior.STATE_EXPANDED);
            tintMenu();
        });
        menu.setOnDismissListener(dialog -> {
            menu = null;
            menuLabels.clear();
            menuDetails.clear();
            menuIcons.clear();
        });
        menu.show();
    }

    private View menuRow(int id, int icon, int label, int detail, Runnable action) {
        LinearLayout row = new LinearLayout(this);
        row.setId(id);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(16), dp(16), dp(16), dp(16));
        row.setMinimumHeight(dp(76));
        row.setBackground(ripple(18));
        row.setFocusable(true);
        row.setOnClickListener(view -> action.run());
        ImageView image = new ImageView(this);
        image.setImageResource(icon);
        menuIcons.add(image);
        LinearLayout.LayoutParams iconLayout = new LinearLayout.LayoutParams(dp(24), dp(24));
        iconLayout.setMarginEnd(dp(20));
        row.addView(image, iconLayout);
        LinearLayout text = new LinearLayout(this);
        text.setOrientation(LinearLayout.VERTICAL);
        TextView primary = new TextView(this);
        primary.setText(label);
        primary.setTextSize(16);
        menuLabels.add(primary);
        text.addView(primary);
        TextView secondary = new TextView(this);
        secondary.setText(detail);
        secondary.setTextSize(12);
        secondary.setPadding(0, dp(4), 0, 0);
        menuDetails.add(secondary);
        text.addView(secondary);
        row.addView(text, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        return row;
    }

    private void tintMenu() {
        if (menu == null || !menu.isShowing()) return;
        menu.findViewById(com.google.android.material.R.id.design_bottom_sheet)
                .setBackgroundTintList(ColorStateList.valueOf(sheetSurface));
        menuHandle.setBackground(rounded(secondary, 2));
        for (TextView label : menuLabels) label.setTextColor(foreground);
        for (TextView detail : menuDetails) detail.setTextColor(secondary);
        for (ImageView icon : menuIcons) icon.setImageTintList(ColorStateList.valueOf(foreground));
    }

    private void reload() {
        if (loadFailed) webView.loadUrl(currentUrl);
        else webView.reload();
    }

    private void showError(String title, String detail) {
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        loadFailed = true;
        progress.setVisibility(View.GONE);
        webView.setVisibility(View.GONE);
        errorTitle.setText(title);
        errorDetail.setText(detail);
        errorPanel.setVisibility(View.VISIBLE);
    }

    private boolean sameServer(Uri uri) {
        Uri server = Uri.parse(BuildConfig.SERVER_URL);
        return "https".equals(uri.getScheme()) && server.getHost().equals(uri.getHost()) && server.getPort() == uri.getPort();
    }

    private void openExternal(Uri uri) {
        if (!"https".equals(uri.getScheme()) && !"mailto".equals(uri.getScheme())) {
            Toast.makeText(this, R.string.unsupported_link, Toast.LENGTH_SHORT).show();
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        startActivity(intent);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        state.putString("currentUrl", currentUrl);
        super.onSaveInstanceState(state);
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush();
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (fullscreenCallback != null && event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) {
                getOnBackPressedDispatcher().onBackPressed();
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && fullscreenContainer != null) enterImmersiveMode();
    }

    @Override
    protected void onDestroy() {
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        hideFullscreen();
        if (menu != null) {
            menu.setDismissWithAnimation(false);
            menu.dismiss();
        }
        if (upload != null) upload.onReceiveValue(null);
        ((ViewGroup) webView.getParent()).removeView(webView);
        webView.destroy();
        super.onDestroy();
    }
}
