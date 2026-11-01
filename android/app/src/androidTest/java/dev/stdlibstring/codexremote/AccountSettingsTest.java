package dev.stdlibstring.codexremote;

import static org.junit.Assert.assertTrue;
import static androidx.test.espresso.Espresso.closeSoftKeyboard;

import android.os.SystemClock;
import android.util.Base64;
import android.webkit.WebView;
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
public final class AccountSettingsTest {
    private WebView webView;

    @Test
    public void settingsNavigationAndPasskeyDialog() throws Exception {
        String encoded = InstrumentationRegistry.getArguments().getString("passwordBase64");
        if (encoded == null) throw new IllegalArgumentException("必须提供测试服务的访问密码。");
        String password = new String(Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_PADDING), StandardCharsets.UTF_8);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                webView = activity.findViewById(R.id.codex_webview);
                webView.loadUrl(BuildConfig.SERVER_URL + "account");
            });
            await("Boolean(document.querySelector('#password')) || document.querySelector('h1')?.textContent === '账户设置'");
            if (evaluate("Boolean(document.querySelector('.signout-button'))").getAsBoolean()) {
                evaluate("document.querySelector('.signout-button').click()");
                await("Boolean(document.querySelector('#password'))");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> webView.loadUrl(BuildConfig.SERVER_URL + "account"));
                await("Boolean(document.querySelector('#password'))");
            }
            evaluate("(() => { const input = document.querySelector('#password'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,"
                    + new JsonPrimitive(password) + "); input.dispatchEvent(new Event('input',{bubbles:true})); })()");
            evaluate("document.querySelector('#login button[type=submit]').click()");
            await("document.querySelector('h1')?.textContent === '账户设置'");
            assertTrue(evaluate("!document.querySelector('#passkey-name') && !document.querySelector('#passkeys-title')").getAsBoolean());
            evaluate("document.querySelector('a[href=\"/account/security\"]').click()");
            await("Boolean(document.querySelector('#passkeys-title')?.parentElement.querySelector('button'))");
            assertTrue(evaluate("document.querySelector('h1').textContent === '登录与安全' && !document.querySelector('dialog')").getAsBoolean());
            evaluate("document.querySelector('#passkeys-title').parentElement.querySelector('button').click()");
            await("Boolean(document.querySelector('dialog[open] #passkey-name'))");
            assertTrue(evaluate("document.activeElement.id === 'passkey-name'").getAsBoolean());
            assertTrue(evaluate("document.documentElement.scrollWidth <= innerWidth && document.querySelector('dialog').scrollWidth <= innerWidth").getAsBoolean());
            closeSoftKeyboard();
            scenario.onActivity(activity -> activity.getOnBackPressedDispatcher().onBackPressed());
            await("!document.querySelector('dialog')");
            assertTrue(evaluate("location.pathname === '/account/security'").getAsBoolean());
            evaluate("document.querySelector('#passkeys-title').parentElement.querySelector('button').click()");
            await("Boolean(document.querySelector('dialog[open]'))");
            evaluate("document.querySelector('.dialog-cancel').click()");
            await("!document.querySelector('dialog')");
            evaluate("document.querySelector('a[href=\"/account\"]').click()");
            await("document.querySelector('h1')?.textContent === '账户设置'");
            evaluate("document.querySelector('.signout-button').click()");
            await("Boolean(document.querySelector('#login')) && location.pathname === '/'");
        }
    }

    private void await(String condition) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 30_000;
        while (SystemClock.elapsedRealtime() < deadline) {
            if (evaluate(condition).getAsBoolean()) return;
            SystemClock.sleep(200);
        }
        throw new AssertionError("页面未完成预期操作：" + condition + "；实际页面："
                + evaluate("({url:location.href,text:document.body?.innerText.slice(0,300)})"));
    }

    private JsonElement evaluate(String script) throws Exception {
        CountDownLatch completed = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> webView.evaluateJavascript(script, value -> {
            result.set(value); completed.countDown();
        }));
        assertTrue("WebView 未返回运行结果。", completed.await(10, TimeUnit.SECONDS));
        return JsonParser.parseString(result.get());
    }
}
