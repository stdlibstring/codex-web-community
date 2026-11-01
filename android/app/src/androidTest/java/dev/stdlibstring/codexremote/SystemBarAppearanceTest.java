package dev.stdlibstring.codexremote;

import static org.junit.Assert.assertEquals;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.matcher.ViewMatchers.withId;

import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.view.View;
import android.widget.CompoundButton;
import androidx.core.view.WindowCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

@RunWith(AndroidJUnit4.class)
public final class SystemBarAppearanceTest {
    @Test
    @SuppressWarnings("deprecation")
    public void systemBarsMatchNativeAppearance() {
        var arguments = InstrumentationRegistry.getArguments();
        String expectedTheme = arguments.getString("expectedNativeTheme");
        String expectedSystem = arguments.getString("expectedSystemTheme");
        String expectedPreference = arguments.getString("expectedPreference");
        String phase = arguments.getString("phase");
        if (!"choose".equals(phase) && !"check".equals(phase)) {
            throw new IllegalArgumentException("phase 需要指定 choose 或 check。");
        }
        if (!"dark".equals(expectedTheme) && !"light".equals(expectedTheme)) {
            throw new IllegalArgumentException("expectedNativeTheme 需要指定 dark 或 light。");
        }
        if (!"dark".equals(expectedSystem) && !"light".equals(expectedSystem)) {
            throw new IllegalArgumentException("expectedSystemTheme 需要指定 dark 或 light。");
        }
        if (expectedPreference == null || !List.of("system", "dark", "light").contains(expectedPreference)) {
            throw new IllegalArgumentException("expectedPreference 需要指定 system、dark 或 light。");
        }
        boolean dark = expectedTheme.equals("dark");
        int background = dark ? Color.rgb(33, 33, 33) : Color.WHITE;
        int expectedNight = expectedSystem.equals("dark") ? Configuration.UI_MODE_NIGHT_YES
                : Configuration.UI_MODE_NIGHT_NO;
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            if (phase.equals("choose")) {
                onView(withId(R.id.codex_more)).perform(click());
                AtomicBoolean following = new AtomicBoolean();
                onView(withId(R.id.codex_follow_system)).check((view, failure) -> {
                    if (failure != null) throw failure;
                    following.set(((CompoundButton) view).isChecked());
                });
                if (!following.get()) onView(withId(R.id.codex_follow_system)).perform(click());
                if (!expectedPreference.equals("system")) onView(withId(R.id.codex_follow_system)).perform(click());
                onView(withId(R.id.codex_menu_close)).perform(click());
            }
            scenario.onActivity(activity -> {
                assertEquals("保存的外观选择", expectedPreference,
                        activity.getPreferences(0).getString("appearanceMode", "system"));
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
