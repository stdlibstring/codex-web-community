package dev.stdlibstring.codexremote;

import android.annotation.SuppressLint;
import android.Manifest;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Build;
import android.provider.Settings;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.Window;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
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
import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.graphics.Insets;
import androidx.core.content.ContextCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.core.widget.NestedScrollView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import androidx.webkit.ScriptHandler;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.appcompat.app.AlertDialog;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.materialswitch.MaterialSwitch;
import com.google.android.material.bottomsheet.BottomSheetBehavior;
import com.google.android.material.bottomsheet.BottomSheetDialog;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.progressindicator.LinearProgressIndicator;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
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
    private String appearanceMode;
    private String appearanceSource;
    private ScriptHandler appearanceScript;
    private boolean appearanceReady;
    private AlertDialog appearanceDialog;
    private String requestedAppearance;
    private MaterialSwitch followSystemSwitch;
    private MaterialSwitch notificationSwitch;
    private boolean updatingNotificationSwitch;
    private String notificationThreadId;
    private String notificationCwd;
    private String notificationWorkspace;
    private String notificationRequest;
    private int surface;
    private int sheetSurface;
    private int foreground;
    private int secondary;
    private int muted;
    private ValueCallback<Uri[]> upload;
    private String currentUrl = BuildConfig.SERVER_URL;
    private boolean loadFailed;
    private JavaScriptReplyProxy navigationReply;
    private String navigationId;
    private boolean navigationCanGoBack;
    private boolean navigationPending;
    private Uri navigationOrigin;
    private PermissionRequest microphoneRequest;
    private PasskeyBridge passkeyBridge;

    private final ActivityResultLauncher<String> microphonePermission = registerForActivityResult(
            new ActivityResultContracts.RequestPermission(), granted -> {
                PermissionRequest request = microphoneRequest;
                microphoneRequest = null;
                if (request == null) return;
                if (granted && microphoneOriginAllowed(request.getOrigin())) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else request.deny();
            });

    private final ActivityResultLauncher<String> notificationPermission = registerForActivityResult(
            new ActivityResultContracts.RequestPermission(), granted -> {
                ReplyNotificationService.settings(this).edit().putBoolean("enabled", granted).apply();
                syncNotifications();
            });

    private final ActivityResultLauncher<Intent> chooser = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(), result -> {
                if (upload == null) return;
                var files = new ActivityResultContracts.GetMultipleContents().parseResult(result.getResultCode(), result.getData());
                ValueCallback<Uri[]> callback = upload;
                upload = null;
                callback.onReceiveValue(files.isEmpty() ? null : files.toArray(new Uri[0]));
            });

    @Override
    protected void onCreate(Bundle state) {
        appearanceMode = getPreferences(MODE_PRIVATE).getString("appearanceMode", "system");
        darkMode = useDarkAppearance();
        setTheme(darkMode ? R.style.Theme_CodexRemote : R.style.Theme_CodexRemote_Light);
        super.onCreate(state);
        ReplyNotificationService.createChannels(this);
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
        toolbar.setPadding(dp(16), 0, dp(8), 0);
        root.addView(toolbar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));
        toolbarTitle = new TextView(this);
        toolbarTitle.setText(R.string.toolbar_title);
        toolbarTitle.setTextSize(18);
        toolbarTitle.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        toolbar.addView(toolbarTitle, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
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
        if (getPreferences(MODE_PRIVATE).getInt("webAssetsVersion", 0) != BuildConfig.VERSION_CODE) {
            webView.clearCache(true);
            getPreferences(MODE_PRIVATE).edit().putInt("webAssetsVersion", BuildConfig.VERSION_CODE).apply();
        }
        applyAppearance();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(windowContent);
                if (insets != null && insets.isVisible(WindowInsetsCompat.Type.ime())) {
                    WindowCompat.getInsetsController(getWindow(), windowContent).hide(WindowInsetsCompat.Type.ime());
                } else if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
                else if (webView.getUrl() != null && "/account/security".equals(Uri.parse(webView.getUrl()).getPath())) {
                    webView.evaluateJavascript("(() => { const dialog = document.querySelector('dialog[open]'); if (!dialog) return false; dialog.dispatchEvent(new Event('cancel', {cancelable:true})); return true; })()",
                            handled -> { if (!"true".equals(handled)) navigateBack(); });
                } else navigateBack();
            }
        });
        if (state != null) {
            currentUrl = state.getString("currentUrl", BuildConfig.SERVER_URL);
            notificationThreadId = state.getString("notificationThreadId");
            notificationCwd = state.getString("notificationCwd");
        }
        readNotificationIntent(getIntent());
        if (notificationThreadId != null) currentUrl = notificationUrl();
        ViewCompat.requestApplyInsets(windowContent);
        if (installAppearanceObserver()) webView.loadUrl(currentUrl);
    }

    private void navigateBack() {
        if (navigationReply != null && navigationCanGoBack) {
            if (navigationPending) return;
            navigationPending = true;
            navigationReply.postMessage(navigationId);
        } else if (webView.canGoBack()) webView.goBack();
        else moveTaskToBack(true);
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
        if (Build.VERSION.SDK_INT >= 28 && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            passkeyBridge = new PasskeyBridge(this, webView);
        }
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
                appearanceReady = false;
                notificationWorkspace = null;
                notificationRequest = null;
                navigationReply = null;
                navigationId = null;
                navigationCanGoBack = false;
                navigationPending = false;
                navigationOrigin = null;
                cancelMicrophoneRequest();
                loadFailed = false;
                errorPanel.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
                progress.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                notifyAppearance();
                CookieManager.getInstance().flush();
                if (sameServer(Uri.parse(url)) && Uri.parse(url).getPath().startsWith("/workbench")) {
                    var notificationSettings = ReplyNotificationService.settings(MainActivity.this);
                    if (!notificationSettings.getBoolean("asked", false)) enableNotifications();
                    else syncNotifications();
                }
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
            public void onPermissionRequest(PermissionRequest request) {
                String[] resources = request.getResources();
                if (resources.length != 1 || !PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resources[0])
                        || !microphoneOriginAllowed(request.getOrigin()) || microphoneRequest != null) {
                    request.deny();
                    return;
                }
                if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    microphoneRequest = request;
                    microphonePermission.launch(Manifest.permission.RECORD_AUDIO);
                }
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (microphoneRequest == request) microphoneRequest = null;
            }

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
            WebViewCompat.addWebMessageListener(webView, "CodexNavigation", Collections.singleton("https://*.vscode-cdn.net"),
                    (view, message, origin, mainFrame, reply) -> {
                        if (mainFrame) return;
                        JsonObject data = JsonParser.parseString(message.getData()).getAsJsonObject();
                        String id = data.get("id").getAsString();
                        switch (data.get("type").getAsString()) {
                            case "ready":
                                navigationReply = reply;
                                navigationOrigin = origin;
                                navigationId = id;
                                navigationCanGoBack = data.get("canGoBack").getAsBoolean();
                                navigationPending = false;
                                break;
                            case "handled":
                                if (id.equals(navigationId)) navigationPending = false;
                                break;
                            case "detached":
                                if (id.equals(navigationId)) {
                                    navigationReply = null;
                                    navigationId = null;
                                    navigationCanGoBack = false;
                                    navigationPending = false;
                                }
                                break;
                            default: throw new IllegalArgumentException("无法识别系统返回导航消息。");
                        }
                    });
            WebViewCompat.addWebMessageListener(webView, "CodexAppearance", origins,
                    (view, message, origin, mainFrame, reply) -> {
                        if (!mainFrame) return;
                        switch (message.getData()) {
                            case "ready": appearanceReady = true; notifyAppearance(); break;
                            case "system": case "dark": case "light": requestAppearancePreference(message.getData()); break;
                            default: throw new IllegalArgumentException("无法识别网页的主题设置。");
                        }
                    });
            WebViewCompat.addWebMessageListener(webView, "CodexNotifications", origins,
                    (view, message, origin, mainFrame, reply) -> {
                        if (!mainFrame) return;
                        JsonObject data = JsonParser.parseString(message.getData()).getAsJsonObject();
                        switch (data.get("type").getAsString()) {
                            case "ready":
                                notificationWorkspace = data.get("cwd").getAsString();
                                openNotificationThread();
                                break;
                            case "opened":
                                if (data.get("threadId").getAsString().equals(notificationThreadId)) {
                                    notificationThreadId = null;
                                    notificationCwd = null;
                                    notificationRequest = null;
                                    getIntent().removeExtra("notificationThreadId");
                                    getIntent().removeExtra("notificationCwd");
                                }
                                break;
                            default: throw new IllegalArgumentException("无法识别通知导航消息。");
                        }
                    });
        } else {
            showError(getString(R.string.webview_update), getString(R.string.webview_update_detail));
            return false;
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            try (Scanner source = new Scanner(getResources().openRawResource(R.raw.appearance), "UTF-8")) {
                appearanceSource = source.useDelimiter("\\A").next();
                updateAppearanceScript();
            }
        } else {
            showError(getString(R.string.webview_update), getString(R.string.webview_update_detail));
            return false;
        }
        return true;
    }

    private boolean useDarkAppearance() {
        switch (appearanceMode) {
            case "dark": return true;
            case "light": return false;
            case "system": return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                    == Configuration.UI_MODE_NIGHT_YES;
            default: throw new IllegalArgumentException("无法识别保存的外观设置。");
        }
    }

    private void applyAppearance() {
        boolean dark = useDarkAppearance();
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
        tintButton(moreButton);
        progress.setIndicatorColor(foreground);
        errorIcon.setImageTintList(ColorStateList.valueOf(secondary));
        errorIcon.setBackground(rounded(muted, 36));
        errorTitle.setTextColor(foreground);
        errorDetail.setTextColor(secondary);
        errorPanel.setBackgroundColor(surface);
        retryButton.setBackgroundTintList(ColorStateList.valueOf(foreground));
        retryButton.setTextColor(surface);
        SystemBarStyle bars = dark ? SystemBarStyle.dark(Color.TRANSPARENT)
                : SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT);
        EdgeToEdge.enable(this, bars, bars);
        tintMenu();
        updateAppearanceScript();
        notifyAppearance();
    }

    private void setAppearancePreference(String preference) {
        if (!List.of("system", "dark", "light").contains(preference)) {
            throw new IllegalArgumentException("外观设置需要是 system、dark 或 light。");
        }
        appearanceMode = preference;
        getPreferences(MODE_PRIVATE).edit().remove("appearance").putString("appearanceMode", preference).apply();
        applyAppearance();
    }

    private void updateAppearanceScript() {
        if (appearanceSource == null) return;
        if (appearanceScript != null) appearanceScript.remove();
        Uri server = Uri.parse(BuildConfig.SERVER_URL);
        String initial = "window.codexNativeAppearanceInitial={preference:'" + appearanceMode
                + "',theme:'" + (darkMode ? "dark" : "light") + "'};";
        appearanceScript = WebViewCompat.addDocumentStartJavaScript(webView, initial + appearanceSource,
                Collections.singleton(server.getScheme() + "://" + server.getAuthority()));
    }

    private void notifyAppearance() {
        if (!appearanceReady || webView.getUrl() == null || !sameServer(Uri.parse(webView.getUrl()))) return;
        webView.evaluateJavascript("window.codexApplyNativeAppearance('" + appearanceMode + "','"
                + (darkMode ? "dark" : "light") + "')", null);
    }

    private void requestAppearancePreference(String preference) {
        if (!List.of("system", "dark", "light").contains(preference)) {
            throw new IllegalArgumentException("无法识别请求的外观设置。");
        }
        if (!appearanceMode.equals("system") || preference.equals("system")) {
            setAppearancePreference(preference);
            return;
        }
        if (appearanceDialog != null) return;
        if (menu != null) menu.dismiss();
        WindowCompat.getInsetsController(getWindow(), windowContent).hide(WindowInsetsCompat.Type.ime());
        AlertDialog confirmation = new MaterialAlertDialogBuilder(this)
                .setTitle(R.string.manual_appearance_title)
                .setMessage(R.string.manual_appearance_detail)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.confirm, (dialog, selected) -> setAppearancePreference(preference))
                .create();
        appearanceDialog = confirmation;
        requestedAppearance = preference;
        confirmation.setOnDismissListener(dialog -> {
            if (appearanceDialog == confirmation) {
                appearanceDialog = null;
                requestedAppearance = null;
            }
        });
        confirmation.show();
        tintDialogWindow(confirmation.getWindow());
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
        body.addView(menuRow(R.id.codex_refresh, R.drawable.ic_refresh, R.string.refresh, R.string.refresh_detail, () -> {
            menu.dismiss();
            reload();
        }));
        followSystemSwitch = new MaterialSwitch(this);
        followSystemSwitch.setId(R.id.codex_follow_system);
        followSystemSwitch.setContentDescription(getString(R.string.follow_system));
        followSystemSwitch.setChecked(appearanceMode.equals("system"));
        followSystemSwitch.setOnCheckedChangeListener((button, checked) ->
                setAppearancePreference(checked ? "system" : darkMode ? "dark" : "light"));
        LinearLayout appearanceRow = (LinearLayout) menuRow(R.id.codex_appearance, R.drawable.ic_appearance,
                R.string.follow_system, R.string.follow_system_detail,
                () -> followSystemSwitch.setChecked(!followSystemSwitch.isChecked()));
        appearanceRow.addView(followSystemSwitch, new LinearLayout.LayoutParams(dp(52), dp(48)));
        body.addView(appearanceRow);
        notificationSwitch = new MaterialSwitch(this);
        notificationSwitch.setId(R.id.codex_notification_switch);
        notificationSwitch.setContentDescription(getString(R.string.reply_notifications));
        notificationSwitch.setChecked(notificationsEnabled());
        notificationSwitch.setOnCheckedChangeListener((button, checked) -> {
            if (updatingNotificationSwitch) return;
            if (checked) enableNotifications();
            else {
                ReplyNotificationService.settings(this).edit().putBoolean("enabled", false)
                        .remove("since").remove("cursor").remove("delivered").apply();
                syncNotifications();
            }
        });
        LinearLayout notificationRow = (LinearLayout) menuRow(R.id.codex_notifications, R.drawable.ic_notification,
                R.string.reply_notifications, R.string.reply_notifications_detail,
                () -> notificationSwitch.setChecked(!notificationSwitch.isChecked()));
        notificationRow.addView(notificationSwitch, new LinearLayout.LayoutParams(dp(52), dp(48)));
        body.addView(notificationRow);
        body.addView(menuRow(R.id.codex_notification_settings, R.drawable.ic_notification,
                R.string.notification_settings, R.string.notification_settings_detail, () -> {
                    menu.dismiss();
                    openNotificationSettings();
                }));
        body.addView(menuRow(R.id.codex_account, R.drawable.ic_account, R.string.account, R.string.account_detail, () -> {
            menu.dismiss();
            webView.loadUrl(BuildConfig.SERVER_URL + "account");
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
            followSystemSwitch = null;
            notificationSwitch = null;
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
        followSystemSwitch.setThumbTintList(new ColorStateList(new int[][] { { android.R.attr.state_checked }, {} }, new int[] { foreground, secondary }));
        followSystemSwitch.setTrackTintList(new ColorStateList(new int[][] { { android.R.attr.state_checked }, {} }, new int[] { secondary, muted }));
        notificationSwitch.setThumbTintList(followSystemSwitch.getThumbTintList());
        notificationSwitch.setTrackTintList(followSystemSwitch.getTrackTintList());
        tintDialogWindow(menu.getWindow());
    }

    @SuppressWarnings("deprecation")
    private void tintDialogWindow(Window window) {
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 29) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
        var controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(!darkMode);
        controller.setAppearanceLightNavigationBars(!darkMode);
    }

    private void reload() {
        if (loadFailed) webView.loadUrl(currentUrl);
        else webView.reload();
    }

    private void readNotificationIntent(Intent intent) {
        String threadId = intent.getStringExtra("notificationThreadId");
        if (threadId == null) return;
        String cwd = intent.getStringExtra("notificationCwd");
        if (!threadId.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
                || cwd == null || !cwd.startsWith("/")) throw new IllegalArgumentException("通知中的会话信息无效。");
        notificationThreadId = threadId;
        notificationCwd = cwd;
        notificationRequest = null;
    }

    private String notificationUrl() {
        return Uri.parse(BuildConfig.SERVER_URL + "workbench/").buildUpon().appendQueryParameter("folder", notificationCwd).build().toString();
    }

    private void openNotificationThread() {
        if (notificationThreadId == null) return;
        if (!notificationCwd.equals(notificationWorkspace)) {
            webView.loadUrl(notificationUrl());
            return;
        }
        if (notificationThreadId.equals(notificationRequest)) return;
        notificationRequest = notificationThreadId;
        webView.evaluateJavascript("window.codexOpenNotificationThread(" + new JsonPrimitive(notificationThreadId) + ")", null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        readNotificationIntent(intent);
        if (notificationThreadId != null) webView.loadUrl(notificationUrl());
    }

    private boolean notificationsEnabled() {
        return ReplyNotificationService.settings(this).getBoolean("enabled", false)
                && ReplyNotificationService.canNotify(this);
    }

    private void openNotificationSettings() {
        startActivity(new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())
                .putExtra(Settings.EXTRA_CHANNEL_ID, ReplyNotificationService.REPLIES));
    }

    private void enableNotifications() {
        var settings = ReplyNotificationService.settings(this);
        boolean asked = settings.getBoolean("asked", false);
        settings.edit().putBoolean("asked", true).apply();
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            if (!asked || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) {
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS);
            } else {
                settings.edit().putBoolean("enabled", true).apply();
                startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
            }
            return;
        }
        settings.edit().putBoolean("enabled", true).apply();
        if (!getSystemService(NotificationManager.class).areNotificationsEnabled()) {
            Toast.makeText(this, R.string.notification_permission, Toast.LENGTH_LONG).show();
            startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
        } else if (!ReplyNotificationService.canNotify(this)) {
            openNotificationSettings();
        }
        syncNotifications();
    }

    private void syncNotifications() {
        boolean enabled = notificationsEnabled();
        if (notificationSwitch != null) {
            updatingNotificationSwitch = true;
            notificationSwitch.setChecked(enabled);
            updatingNotificationSwitch = false;
        }
        Intent service = new Intent(this, ReplyNotificationService.class);
        if (enabled) ContextCompat.startForegroundService(this, service);
        else stopService(service);
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

    private boolean microphoneOriginAllowed(Uri origin) {
        return webView.getUrl() != null && sameServer(Uri.parse(webView.getUrl()))
                && Uri.parse(webView.getUrl()).getPath().startsWith("/workbench/")
                && navigationOrigin != null && navigationOrigin.getScheme().equals(origin.getScheme())
                && navigationOrigin.getAuthority().equals(origin.getAuthority());
    }

    private void cancelMicrophoneRequest() {
        if (microphoneRequest == null) return;
        microphoneRequest.deny();
        microphoneRequest = null;
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
        state.putString("notificationThreadId", notificationThreadId);
        state.putString("notificationCwd", notificationCwd);
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
        syncNotifications();
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
    public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        String pending = requestedAppearance;
        if (appearanceDialog != null) appearanceDialog.dismiss();
        appearanceDialog = null;
        requestedAppearance = null;
        applyAppearance();
        if (pending != null) requestAppearancePreference(pending);
    }

    @Override
    protected void onDestroy() {
        cancelMicrophoneRequest();
        if (passkeyBridge != null) passkeyBridge.close();
        if (appearanceDialog != null) appearanceDialog.dismiss();
        if (appearanceScript != null) appearanceScript.remove();
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
