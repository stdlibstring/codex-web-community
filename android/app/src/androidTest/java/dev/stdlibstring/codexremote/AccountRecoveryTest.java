package dev.stdlibstring.codexremote;

import static org.junit.Assert.assertTrue;

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
public final class AccountRecoveryTest {
    private WebView webView;

    @Test
    public void passwordSettingsAndChange() throws Exception {
        String current = argument("passwordBase64");
        String next = argument("newPasswordBase64");
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            open(scenario, "account/security");
            await("Boolean(document.querySelector('#password'))");
            fill("password", current);
            evaluate("document.querySelector('#login button[type=submit]').click()");
            await("Boolean(document.querySelector('#mail-service-title')?.parentElement.querySelector('button:not(:disabled)'))");
            evaluate("document.querySelector('#mail-service-title').parentElement.querySelector('button').click()");
            await("Boolean(document.querySelector('#account-current-password'))");
            fill("account-current-password", current);
            evaluate("document.querySelector('dialog[open] button.primary').click()");
            await("Boolean(document.querySelector('#smtp-authorization'))");
            assertTrue(evaluate("document.querySelector('#smtp-host').value === 'smtp.qq.com' && document.querySelector('#smtp-port').value === '465' && document.querySelector('#smtp-authorization').type === 'password'").getAsBoolean());
            assertTrue(evaluate("document.documentElement.scrollWidth <= innerWidth && document.querySelector('dialog[open]').scrollWidth <= document.querySelector('dialog[open]').clientWidth").getAsBoolean());
            evaluate("document.querySelector('dialog[open] .dialog-cancel').click()");
            evaluate("document.querySelector('#password-title').parentElement.querySelector('button').click()");
            await("Boolean(document.querySelector('#account-current-password'))");
            fill("account-current-password", current);
            evaluate("document.querySelector('dialog[open] button.primary').click()");
            await("Boolean(document.querySelector('#new-password'))");
            fill("new-password", next); fill("confirm-password", next);
            evaluate("document.querySelector('dialog[open] button.primary').click()");
            await("Boolean(document.querySelector('#login')) && document.body.innerText.includes('密码已修改，请重新登录')");
            open(scenario, "account/security");
            await("Boolean(document.querySelector('#password'))");
            fill("password", next);
            evaluate("document.querySelector('#login button[type=submit]').click()");
            await("Boolean(document.querySelector('#password-title'))");
        }
    }

    @Test
    public void confirmRecoveryEmail() throws Exception {
        String token = argument("linkTokenBase64");
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            open(scenario, "verify-email#token=" + token);
            await("Boolean(document.querySelector('form button.primary'))");
            assertTrue(evaluate("location.hash === ''").getAsBoolean());
            evaluate("document.querySelector('form button.primary').click()");
            await("document.querySelector('h1')?.textContent === '邮箱确认完成'");
            assertTrue(evaluate("document.body.innerText.includes('恢复邮箱已验证')").getAsBoolean());
        }
    }

    @Test
    public void resetPasswordAndRejectReusedLink() throws Exception {
        String token = argument("linkTokenBase64");
        String next = argument("newPasswordBase64");
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            open(scenario, "recover#token=" + token);
            await("Boolean(document.querySelector('#new-password'))");
            assertTrue(evaluate("location.hash === '' && document.documentElement.scrollWidth <= innerWidth").getAsBoolean());
            fill("new-password", next); fill("confirm-password", next);
            evaluate("document.querySelector('form button.primary').click()");
            await("document.querySelector('h1')?.textContent === '密码已重置'");
            open(scenario, "recover#token=" + token);
            await("Boolean(document.querySelector('[role=alert]'))");
            assertTrue(evaluate("document.querySelector('[role=alert]').textContent.includes('失效') && !document.querySelector('#new-password')").getAsBoolean());
        }
    }

    private String argument(String name) {
        String value = InstrumentationRegistry.getArguments().getString(name);
        if (value == null) throw new IllegalArgumentException("缺少验证参数：" + name);
        return new String(Base64.decode(value, Base64.URL_SAFE | Base64.NO_PADDING), StandardCharsets.UTF_8);
    }

    private void open(ActivityScenario<MainActivity> scenario, String path) throws Exception {
        scenario.onActivity(activity -> {
            webView = activity.findViewById(R.id.codex_webview);
            webView.loadUrl(BuildConfig.SERVER_URL + path);
        });
        String route = "/" + path.split("#", 2)[0];
        await("location.pathname === " + new JsonPrimitive(route) + " && document.readyState === 'complete'");
    }

    private void fill(String id, String value) throws Exception {
        evaluate("(() => { const input = document.getElementById(" + new JsonPrimitive(id)
                + "); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input,"
                + new JsonPrimitive(value) + "); input.dispatchEvent(new Event('input', {bubbles:true})); })()");
    }

    private void await(String condition) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 30_000;
        while (SystemClock.elapsedRealtime() < deadline) {
            if (evaluate(condition).getAsBoolean()) return;
            SystemClock.sleep(200);
        }
        throw new AssertionError("页面没有完成预期操作。地址：" + evaluate("location.href.split('#')[0]"));
    }

    private JsonElement evaluate(String script) throws Exception {
        CountDownLatch completed = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> webView.evaluateJavascript(script, value -> {
            result.set(value); completed.countDown();
        }));
        assertTrue("WebView 没有返回执行结果。", completed.await(10, TimeUnit.SECONDS));
        return JsonParser.parseString(result.get());
    }
}
