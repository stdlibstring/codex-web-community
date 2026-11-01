package dev.stdlibstring.codexremote;

import static org.junit.Assert.assertTrue;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.Intent;
import android.os.SystemClock;
import android.util.Base64;
import android.webkit.WebView;
import androidx.core.content.ContextCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.google.gson.JsonElement;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class NotificationTransportTest {
    private WebView webView;
    private NotificationManager manager;

    @Test
    public void rateLimitKeepsAppRunningAndNotificationsRecover() throws Exception {
        String encoded = InstrumentationRegistry.getArguments().getString("passwordBase64");
        if (encoded == null) throw new IllegalArgumentException("必须提供测试服务的访问密码。");
        String password = new String(Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_PADDING), StandardCharsets.UTF_8);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                webView = activity.findViewById(R.id.codex_webview);
                manager = activity.getSystemService(NotificationManager.class);
                webView.loadUrl(BuildConfig.SERVER_URL + "account");
            });
            awaitPage("Boolean(document.querySelector('#password'))");
            evaluate("fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:"
                    + new JsonPrimitive(password) + "})}).then(response=>window.transportLogin=response.status)");
            awaitPage("window.transportLogin === 200");
            scenario.onActivity(activity -> {
                ReplyNotificationService.settings(activity).edit().putBoolean("enabled", true).putBoolean("asked", true).commit();
                ContextCompat.startForegroundService(activity, new Intent(activity, ReplyNotificationService.class));
            });
            awaitStatus(webView.getContext().getString(R.string.notification_connected), 45_000);
            long cursor = ReplyNotificationService.settings(webView.getContext()).getLong("cursor", 0);
            evaluate("(async()=>{for(let index=0;index<61;index++){const response=await fetch('/api/notifications?since=9999999999');"
                    + "if(response.status===429){window.transportLimited=true;return;}"
                    + "if(response.status!==400)throw new Error('实际接口返回状态异常：'+response.status);}})()");
            awaitPage("window.transportLimited === true");
            awaitStatus(webView.getContext().getString(R.string.http_error, 429), 30_000);
            assertTrue("接口错误期间需要保留通知进度。",
                    ReplyNotificationService.settings(webView.getContext()).getLong("cursor", 0) == cursor);
            awaitStatus(webView.getContext().getString(R.string.notification_connected), 90_000);
            assertTrue("限流结束后需要继续接收通知。",
                    ReplyNotificationService.settings(webView.getContext()).getLong("cursor", 0) > cursor);
            scenario.onActivity(activity -> {
                ReplyNotificationService.settings(activity).edit().putBoolean("enabled", false).commit();
                activity.stopService(new Intent(activity, ReplyNotificationService.class));
            });
        }
    }

    private void awaitStatus(String expected, long timeout) {
        long deadline = SystemClock.elapsedRealtime() + timeout;
        while (SystemClock.elapsedRealtime() < deadline) {
            for (var notification : manager.getActiveNotifications()) {
                if (notification.getId() == 1
                        && expected.contentEquals(notification.getNotification().extras.getCharSequence(Notification.EXTRA_TEXT, ""))) return;
            }
            SystemClock.sleep(200);
        }
        throw new AssertionError("通知连接未进入预期状态：" + expected);
    }

    private void awaitPage(String condition) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 30_000;
        while (SystemClock.elapsedRealtime() < deadline) {
            if (evaluate(condition).getAsBoolean()) return;
            SystemClock.sleep(200);
        }
        throw new AssertionError("页面未完成预期操作：" + condition);
    }

    private JsonElement evaluate(String script) throws Exception {
        CountDownLatch completed = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> webView.evaluateJavascript(script, value -> {
            result.set(value);
            completed.countDown();
        }));
        assertTrue("WebView 未返回运行结果。", completed.await(10, TimeUnit.SECONDS));
        return JsonParser.parseString(result.get());
    }
}
