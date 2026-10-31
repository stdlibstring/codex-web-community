package dev.stdlibstring.codexremote;

import static org.junit.Assert.assertEquals;

import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.SystemClock;
import android.view.View;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.atomic.AtomicBoolean;

@RunWith(AndroidJUnit4.class)
public final class SystemBarAppearanceTest {
    @Test
    @SuppressWarnings("deprecation")
    public void systemBarsMatchNativeAppearance() {
        var arguments = InstrumentationRegistry.getArguments();
        String expectedTheme = arguments.getString("expectedNativeTheme");
        String expectedSystem = arguments.getString("expectedSystemTheme");
        String expectedPage = arguments.getString("expectedPageTheme");
        if (!"dark".equals(expectedTheme) && !"light".equals(expectedTheme)) {
            throw new IllegalArgumentException("expectedNativeTheme 需要指定 dark 或 light。");
        }
        if (!"dark".equals(expectedSystem) && !"light".equals(expectedSystem)) {
            throw new IllegalArgumentException("expectedSystemTheme 需要指定 dark 或 light。");
        }
        if (expectedPage != null && !"dark".equals(expectedPage) && !"light".equals(expectedPage)) {
            throw new IllegalArgumentException("expectedPageTheme 需要指定 dark 或 light。");
        }
        boolean dark = expectedTheme.equals("dark");
        int background = dark ? Color.rgb(33, 33, 33) : Color.WHITE;
        int expectedNight = expectedSystem.equals("dark") ? Configuration.UI_MODE_NIGHT_YES
                : Configuration.UI_MODE_NIGHT_NO;
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            if (expectedPage != null) {
                AtomicBoolean ready = new AtomicBoolean();
                long deadline = SystemClock.elapsedRealtime() + 60_000;
                while (!ready.get() && SystemClock.elapsedRealtime() < deadline) {
                    scenario.onActivity(activity -> {
                        WebView web = activity.findViewById(R.id.codex_webview);
                        ready.set(web.getUrl() != null && web.getUrl().contains("/workbench/")
                                && web.getProgress() == 100
                                && expectedPage.equals(activity.getPreferences(0).getString("appearance", null)));
                    });
                    if (!ready.get()) SystemClock.sleep(100);
                }
                assertEquals("真实工作台已加载并发送所选主题", true, ready.get());
            }
            scenario.onActivity(activity -> {
                assertEquals("手机的实际主题", expectedNight,
                        activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK);
                View root = activity.findViewById(R.id.codex_root);
                assertEquals("原生界面背景", background, ((ColorDrawable) root.getBackground()).getColor());
                assertEquals("系统栏下方的实际背景", background,
                        ((ColorDrawable) ((View) root.getParent()).getBackground()).getColor());
                var window = activity.getWindow();
                assertEquals("状态栏透明背景", Color.TRANSPARENT, window.getStatusBarColor());
                assertEquals("导航栏透明背景", Color.TRANSPARENT, window.getNavigationBarColor());
                var controller = WindowCompat.getInsetsController(window, window.getDecorView());
                assertEquals("状态栏图标颜色", !dark, controller.isAppearanceLightStatusBars());
                assertEquals("导航栏图标颜色", !dark, controller.isAppearanceLightNavigationBars());
            });
        }
    }
}
