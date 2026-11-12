package ru.uspevator.app;

import android.app.Notification;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONException;

public final class TimerService extends Service {
    private static final String PREVIEW = "preview";
    private static TimerService instance;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final SignalSchedule schedule = new SignalSchedule();
    private final SignalPlayer player = new SignalPlayer();
    private final Runnable signalTick = this::updateSignal;
    private final Runnable widgetTick = this::updateWidgets;
    private final BroadcastReceiver screen = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { updateWidgets(); }
    };
    private PowerManager power;
    private PowerManager.WakeLock wakeLock;
    private long previewUntil;
    private boolean foreground, stopping;

    static void reconcile(Context context, boolean userInitiated) {
        if (instance != null && !instance.stopping) {
            instance.reconcileNow();
            return;
        }
        PlanState plan = PlanStore.readPlan(context);
        boolean needed = plan != null && ((plan.running() && plan.sound()) || activeDisplays(context, plan));
        if (needed && userInitiated && start(context, false)) return;
        PlanNotification.syncStandalone(context, plan);
    }

    private static boolean activeDisplays(Context context, PlanState plan) {
        return plan.active() && (PlanWidget.ids(context).length > 0 || PlanNotification.enabled(context));
    }

    static boolean testSignal(Context context) {
        if (instance != null && !instance.stopping) {
            instance.preview();
            return true;
        }
        return start(context, true);
    }

    private static boolean start(Context context, boolean preview) {
        try {
            Intent service = new Intent(context, TimerService.class);
            if (preview) service.setAction(PREVIEW);
            context.startForegroundService(service);
            return true;
        } catch (IllegalStateException | SecurityException error) {
            Log.w("UspevatorAudio", "Android refused to start the timer service", error);
            return false;
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        power = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Uspevator:TaskSignal");
        wakeLock.setReferenceCounted(false);
        IntentFilter filter = new IntentFilter(Intent.ACTION_SCREEN_ON);
        filter.addAction(Intent.ACTION_SCREEN_OFF);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(screen, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(screen, filter);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        stopping = false;
        if (intent != null && PREVIEW.equals(intent.getAction())) preview();
        else reconcileNow();
        return START_STICKY;
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private void preview() {
        reconcileNow(true);
    }

    private void reconcileNow() {
        reconcileNow(false);
    }

    private void reconcileNow(boolean startPreview) {
        PlanState plan = PlanStore.readPlan(this);
        boolean audio = plan != null && plan.running() && plan.sound();
        boolean displays = plan != null && activeDisplays(this, plan);
        boolean previewing = startPreview || previewUntil > SystemClock.elapsedRealtime();
        if (!audio && !displays && !previewing) {
            // An already queued startForegroundService call must be acknowledged.
            if (!foreground) enterForeground(plan, false, true);
            stopPlayback();
            boolean keepNotification = PlanNotification.enabled(this);
            stopForeground(keepNotification ? STOP_FOREGROUND_DETACH : STOP_FOREGROUND_REMOVE);
            if (keepNotification) PlanNotification.post(this, plan);
            foreground = false;
            stopping = true;
            stopSelf();
            return;
        }
        enterForeground(plan, audio || previewing, displays);
        player.setVolume(PlanStore.preferences(this).getInt(PlanStore.SIGNAL_VOLUME, PlanStore.DEFAULT_VOLUME));
        if ((audio || previewing) && !wakeLock.isHeld()) wakeLock.acquire();
        if (!audio && !previewing && wakeLock.isHeld()) wakeLock.release();
        if (startPreview) {
            player.play(SignalSchedule.Pattern.WARNING);
            previewUntil = SystemClock.elapsedRealtime() + SignalSchedule.WARNING_MS;
        }
        updateSignal();
        updateWidgets();
    }

    private void enterForeground(PlanState plan, boolean audio, boolean displays) {
        Notification notification = PlanNotification.build(this, plan, PlanNotification.enabled(this));
        if (Build.VERSION.SDK_INT >= 34) {
            int type = (audio ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0)
                | (displays ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0);
            startForeground(PlanNotification.ID, notification, type);
        } else {
            startForeground(PlanNotification.ID, notification);
        }
        foreground = true;
    }

    private void updateSignal() {
        handler.removeCallbacks(signalTick);
        long now = SystemClock.elapsedRealtime();
        if (previewUntil > now) {
            handler.postDelayed(signalTick, previewUntil - now);
            return;
        }
        if (previewUntil != 0) {
            previewUntil = 0;
            player.stop();
            reconcileNow();
            return;
        }
        PlanState plan = PlanStore.readPlan(this);
        if (plan == null || !plan.running() || !plan.sound()) {
            stopPlayback();
            return;
        }
        try {
            PlanState.Clock clock = plan.currentClock(System.currentTimeMillis());
            if (clock == null) {
                stopPlayback();
                return;
            }
            SignalSchedule.Event event = schedule.next(clock, now);
            player.play(event.pattern);
            handler.postDelayed(signalTick, event.delay);
        } catch (JSONException error) {
            Log.w("UspevatorAudio", "Invalid countdown", error);
            stopPlayback();
        }
    }

    private void stopPlayback() {
        handler.removeCallbacks(signalTick);
        previewUntil = 0;
        schedule.suspend();
        player.stop();
        if (wakeLock.isHeld()) wakeLock.release();
    }

    private void updateWidgets() {
        handler.removeCallbacks(widgetTick);
        PlanState plan = PlanStore.readPlan(this);
        if (!power.isInteractive() || plan == null || !plan.active()) return;
        boolean home = PlanWidget.updateAll(this);
        boolean shade = PlanNotification.enabled(this);
        if (shade) PlanNotification.post(this, plan);
        if (home || shade) handler.postDelayed(widgetTick, 10_000);
    }

    @Override public void onDestroy() {
        if (instance == this) instance = null;
        unregisterReceiver(screen);
        handler.removeCallbacksAndMessages(null);
        stopPlayback();
        player.close();
        super.onDestroy();
    }
}
