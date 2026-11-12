package ru.uspevator.app;

import android.Manifest;
import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity implements SharedPreferences.OnSharedPreferenceChangeListener {
    private static final String APP_URL = "https://uspevator.android.invalid/index.html";
    private static final int IMPORT = 1, EXPORT = 2, SHADE_PERMISSION = 3;
    private static final String SHADE_ASKED = "shade_permission_asked";
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService documents = Executors.newSingleThreadExecutor();

    private WebView web;
    private FrameLayout frame;
    private SharedPreferences prefs;
    private boolean pageReady, resumed, pickerBusy;
    private volatile boolean shadePermissionPending, shadeSettingsPending;
    private String pendingForm, pendingToken, pendingImport;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (saved != null) {
            pickerBusy = saved.getBoolean("pickerBusy");
            shadePermissionPending = saved.getBoolean("shadePermissionPending");
            shadeSettingsPending = saved.getBoolean("shadeSettingsPending");
        }
        prefs = PlanStore.preferences(this);
        prefs.registerOnSharedPreferenceChangeListener(this);
        frame = new FrameLayout(this);
        web = new WebView(this);
        frame.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(frame);
        if (Build.VERSION.SDK_INT >= 35) fitSystemBars(frame);
        applyWindowTheme();
        configureWebView();
        readWidgetForm(getIntent());
        try (InputStream stream = getAssets().open("index.html")) {
            web.loadDataWithBaseURL(APP_URL, readText(stream), "text/html", "UTF-8", APP_URL);
        } catch (IOException error) {
            Log.e("Uspevator", "Could not load UI", error);
            toast(R.string.ui_open_failed);
            finish();
        }
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putBoolean("pickerBusy", pickerBusy);
        state.putBoolean("shadePermissionPending", shadePermissionPending);
        state.putBoolean("shadeSettingsPending", shadeSettingsPending);
        super.onSaveInstanceState(state);
    }

    private void fitSystemBars(FrameLayout frame) {
        getWindow().setDecorFitsSystemWindows(false);
        frame.setOnApplyWindowInsetsListener((view, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            return insets;
        });
        frame.requestApplyInsets();
    }

    private boolean systemDark() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
            == Configuration.UI_MODE_NIGHT_YES;
    }

    private void applyWindowTheme() {
        String choice = prefs.getString(PlanStore.THEME, "system");
        boolean dark = "dark".equals(choice) || ("system".equals(choice) && systemDark());
        int background = dark ? Color.rgb(23, 20, 31) : Color.rgb(246, 245, 250);
        frame.setBackgroundColor(background);
        web.setBackgroundColor(background);
        if (Build.VERSION.SDK_INT < 35) {
            getWindow().setStatusBarColor(background);
            getWindow().setNavigationBarColor(background);
        }
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                int flags = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(dark ? 0 : flags, flags);
            }
        } else {
            View decor = getWindow().getDecorView();
            int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            decor.setSystemUiVisibility((decor.getSystemUiVisibility() & ~flags) | (dark ? 0 : flags));
        }
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        applyWindowTheme();
        refresh();
        if (resumed && PlanNotification.enabled(this)) TimerService.reconcile(this, true);
    }

    private void configureWebView() {
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setBlockNetworkLoads(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.addJavascriptInterface(new Bridge(), "UspevatorAndroid");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR || message.messageLevel() == ConsoleMessage.MessageLevel.WARNING) {
                    Log.w("UspevatorWeb", "Line " + message.lineNumber() + " " + message.message());
                }
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (APP_URL.equals(uri.buildUpon().fragment(null).build().toString())) return false;
                if (request.isForMainFrame() && request.hasGesture() && "https".equals(uri.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
                    catch (ActivityNotFoundException error) { toast(R.string.browser_unavailable); }
                }
                return true;
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
            }

            @Override public void onPageFinished(WebView view, String url) {
                pageReady = true;
                refresh();
                deliverActions();
            }

            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                pageReady = false;
                toast(R.string.ui_closed);
                finish();
                return true;
            }
        });
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        readWidgetForm(intent);
        refresh();
        deliverActions();
    }

    private void readWidgetForm(Intent intent) {
        String form = intent.getStringExtra(PlanWidget.FORM);
        pendingForm = PlanWidget.isForm(form) ? form : null;
        pendingToken = intent.getStringExtra(PlanWidget.TOKEN);
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        web.onResume();
        if (shadeSettingsPending) {
            shadeSettingsPending = false;
            if (PlanNotification.allowed(this)) prefs.edit().putBoolean(PlanStore.SHADE_TIMER, true).apply();
        }
        applyWindowTheme();
        updateKeepScreen();
        refresh();
        deliverActions();
        PlanWidget.updateAll(this);
        TimerService.reconcile(this, true);
    }

    @Override protected void onPause() {
        resumed = false;
        updateKeepScreen();
        web.onPause();
        super.onPause();
    }

    @Override protected void onDestroy() {
        prefs.unregisterOnSharedPreferenceChangeListener(this);
        pageReady = false;
        if (web != null) {
            if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
            web.destroy();
            web = null;
        }
        documents.shutdown();
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        if (pageReady && web != null) {
            web.evaluateJavascript("Boolean(window.uspevatorAndroidBack && window.uspevatorAndroidBack())",
                handled -> { if (!"true".equals(handled) && !isFinishing()) super.onBackPressed(); });
        } else super.onBackPressed();
    }

    @Override public void onSharedPreferenceChanged(SharedPreferences preferences, String key) {
        if (PlanStore.THEME.equals(key) && web != null) applyWindowTheme();
        if (PlanStore.PLAN_KEY.equals(key) || PlanStore.THEME.equals(key) || PlanStore.SHADE_TIMER.equals(key)) refresh();
        if (PlanStore.PLAN_KEY.equals(key) || PlanStore.KEEP_SCREEN.equals(key)) updateKeepScreen();
    }

    private void saveShadeTimer(boolean enabled) {
        prefs.edit().putBoolean(PlanStore.SHADE_TIMER, enabled).apply();
        TimerService.reconcile(this, resumed);
        refresh();
    }

    private void changeShadeTimer(boolean enabled) {
        if (!enabled) {
            saveShadeTimer(false);
            return;
        }
        if (!resumed || shadePermissionPending || shadeSettingsPending) {
            refresh();
            return;
        }
        if (PlanNotification.allowed(this)) {
            saveShadeTimer(true);
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && !PlanNotification.permissionGranted(this)
                && (!prefs.getBoolean(SHADE_ASKED, false) || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))) {
            shadePermissionPending = true;
            prefs.edit().putBoolean(SHADE_ASKED, true).apply();
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, SHADE_PERMISSION);
            return;
        }
        try {
            shadeSettingsPending = true;
            startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
        } catch (ActivityNotFoundException error) {
            shadeSettingsPending = false;
            toast(R.string.notification_permission);
            refresh();
        }
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != SHADE_PERMISSION) return;
        shadePermissionPending = false;
        if (PlanNotification.allowed(this)) saveShadeTimer(true);
        else {
            refresh();
            toast(R.string.notification_timer_permission);
        }
    }

    private void updateKeepScreen() {
        PlanState plan = resumed && prefs.getBoolean(PlanStore.KEEP_SCREEN, true) ? PlanStore.readPlan(this) : null;
        if (plan != null && plan.running()) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private void refresh() {
        evaluate("window.uspevatorAndroidRefresh && window.uspevatorAndroidRefresh()");
    }

    private void evaluate(String script) {
        if (pageReady && web != null) web.evaluateJavascript(script, null);
    }

    private void deliverActions() {
        if (!pageReady || !resumed) return;
        if (pendingImport != null) {
            evaluate("window.uspevatorAndroidImport(" + JSONObject.quote(pendingImport) + ")");
            pendingImport = null;
        }
        if (pendingForm == null) return;
        PlanState plan = PlanStore.readPlan(this);
        if (Objects.equals(pendingToken, plan == null ? null : plan.token)) {
            evaluate("window.uspevatorAndroidForm(" + JSONObject.quote(pendingForm) + ")");
        } else toast(R.string.widget_stale_form);
        pendingForm = null;
        pendingToken = null;
    }

    private void launchPicker(Intent intent, int requestCode) {
        try { startActivityForResult(intent, requestCode); }
        catch (ActivityNotFoundException error) {
            pickerBusy = false;
            if (requestCode == EXPORT) pendingExport().delete();
            toast(R.string.file_picker_unavailable);
        }
    }

    private File pendingExport() { return new File(getCacheDir(), "pending-export.json"); }

    private void prepareExport(String filename, String data) {
        if (pickerBusy) return;
        if (data == null || data.length() > PlanStore.MAX_JSON_BYTES) {
            toast(R.string.backup_too_large);
            return;
        }
        pickerBusy = true;
        documents.execute(() -> {
            try (FileOutputStream stream = new FileOutputStream(pendingExport())) {
                byte[] bytes = data.getBytes(StandardCharsets.UTF_8);
                if (bytes.length > PlanStore.MAX_JSON_BYTES) throw new IOException("Backup exceeds import limit");
                stream.write(bytes);
            } catch (IOException error) {
                pendingExport().delete();
                documentError(R.string.export_prepare_failed, error);
                return;
            }
            main.post(() -> {
                if (isFinishing() || isDestroyed()) {
                    pendingExport().delete();
                    return;
                }
                String name = "uspevator_backup.json".equals(filename) ? filename : "uspevator_data.json";
                launchPicker(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("application/json").putExtra(Intent.EXTRA_TITLE, name), EXPORT);
            });
        });
    }

    @Override protected void onActivityResult(int requestCode, int result, Intent data) {
        super.onActivityResult(requestCode, result, data);
        if (requestCode != IMPORT && requestCode != EXPORT) return;
        Uri uri = data == null ? null : data.getData();
        if (result != RESULT_OK || uri == null) {
            pickerBusy = false;
            if (requestCode == EXPORT) pendingExport().delete();
            return;
        }
        documents.execute(() -> transferDocument(requestCode, uri));
    }

    private void transferDocument(int requestCode, Uri uri) {
        try {
            if (requestCode == IMPORT) {
                String text;
                try (InputStream stream = getContentResolver().openInputStream(uri)) { text = readText(stream); }
                main.post(() -> {
                    pickerBusy = false;
                    pendingImport = text;
                    deliverActions();
                });
            } else {
                try (InputStream source = new FileInputStream(pendingExport());
                     OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
                    if (out == null) throw new IOException("No output stream");
                    byte[] buffer = new byte[8192];
                    int length;
                    while ((length = source.read(buffer)) != -1) out.write(buffer, 0, length);
                }
                main.post(() -> { pickerBusy = false; toast(R.string.file_saved); });
            }
        } catch (IOException | SecurityException error) {
            documentError(requestCode == IMPORT ? R.string.json_read_failed : R.string.file_save_failed, error);
        } finally {
            if (requestCode == EXPORT) pendingExport().delete();
        }
    }

    private void documentError(int message, Exception error) {
        Log.w("Uspevator", AppLanguage.text(this, message), error);
        main.post(() -> { pickerBusy = false; toast(message); });
    }

    private static String readText(InputStream source) throws IOException {
        if (source == null) throw new IOException("No input stream");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int length;
        while ((length = source.read(buffer)) != -1) {
            if (bytes.size() + length > PlanStore.MAX_JSON_BYTES) throw new IOException("File too large");
            bytes.write(buffer, 0, length);
        }
        return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
    }

    private void stateChanged() {
        PlanWidget.updateAll(this);
        TimerService.reconcile(this, true);
    }

    private void toast(int message) { Toast.makeText(this, AppLanguage.text(this, message), Toast.LENGTH_SHORT).show(); }

    public final class Bridge {
        @JavascriptInterface public String systemLanguage() { return AppLanguage.systemLanguage(); }

        @JavascriptInterface public String theme() { return prefs.getString(PlanStore.THEME, "system"); }

        @JavascriptInterface public boolean systemDark() { return MainActivity.this.systemDark(); }

        @JavascriptInterface public void setTheme(String theme) {
            if ("system".equals(theme) || "light".equals(theme) || "dark".equals(theme)) {
                main.post(() -> prefs.edit().putString(PlanStore.THEME, theme).apply());
            }
        }

        @JavascriptInterface public boolean shadeTimer() { return PlanNotification.enabled(MainActivity.this); }

        @JavascriptInterface public boolean shadePermissionPending() { return shadePermissionPending || shadeSettingsPending; }

        @JavascriptInterface public void setShadeTimer(boolean enabled) { main.post(() -> changeShadeTimer(enabled)); }

        @JavascriptInterface public String readPlan() {
            return PlanStore.read(MainActivity.this);
        }

        @JavascriptInterface public String writePlan(String expected, String data, boolean finish) {
            String result = PlanStore.compareAndSet(MainActivity.this, expected.isEmpty() ? null : expected, data, finish);
            if ("ok".equals(result)) main.post(MainActivity.this::stateChanged);
            return result;
        }

        @JavascriptInterface public boolean canUndoFinish(String expected) {
            return PlanStore.canUndoFinish(expected);
        }

        @JavascriptInterface public boolean undoFinish(String expected) {
            boolean restored = PlanStore.undoFinish(MainActivity.this, expected);
            if (restored) main.post(MainActivity.this::stateChanged);
            return restored;
        }

        @JavascriptInterface public boolean keepScreen() { return prefs.getBoolean(PlanStore.KEEP_SCREEN, true); }

        @JavascriptInterface public void setKeepScreen(boolean enabled) {
            main.post(() -> prefs.edit().putBoolean(PlanStore.KEEP_SCREEN, enabled).apply());
        }

        @JavascriptInterface public int signalVolume() {
            return prefs.getInt(PlanStore.SIGNAL_VOLUME, PlanStore.DEFAULT_VOLUME);
        }

        @JavascriptInterface public void setSignalVolume(int percent) {
            main.post(() -> {
                prefs.edit().putInt(PlanStore.SIGNAL_VOLUME, Math.max(10, Math.min(100, percent))).apply();
                TimerService.reconcile(MainActivity.this, true);
            });
        }

        @JavascriptInterface public boolean testSignal() {
            main.post(() -> {
                if (!TimerService.testSignal(MainActivity.this)) toast(R.string.signal_start_failed);
            });
            return true;
        }

        @JavascriptInterface public void pinWidget() {
            main.post(() -> {
                AppWidgetManager manager = AppWidgetManager.getInstance(MainActivity.this);
                ComponentName widget = new ComponentName(MainActivity.this, PlanWidget.class);
                if (!manager.isRequestPinAppWidgetSupported() || !manager.requestPinAppWidget(widget, null, null)) {
                    toast(R.string.pin_widget_hint);
                }
            });
        }

        @JavascriptInterface public void importJson() {
            main.post(() -> {
                if (pickerBusy) return;
                pickerBusy = true;
                launchPicker(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*"), IMPORT);
            });
        }

        @JavascriptInterface public void exportJson(String name, String data) {
            main.post(() -> prepareExport(name, data));
        }
    }
}
