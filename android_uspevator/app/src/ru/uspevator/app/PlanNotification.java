package ru.uspevator.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

final class PlanNotification {
    static final int ID = 17;
    static final String CHANNEL = "plan_timer";
    static final String DISMISS = "ru.uspevator.app.SHADE_DISMISS";
    private static final int SURFACE = -17;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static Runnable undoRefresh;

    private PlanNotification() {}

    private static void createChannel(Context context, String name) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
        if (channel != null) {
            if (name.contentEquals(channel.getName())) return;
            channel.setName(name);
        } else {
            channel = new NotificationChannel(CHANNEL, name, NotificationManager.IMPORTANCE_LOW);
            channel.setSound(null, null);
            channel.enableVibration(false);
            channel.setShowBadge(false);
        }
        manager.createNotificationChannel(channel);
    }

    static boolean permissionGranted(Context context) {
        return Build.VERSION.SDK_INT < 33
            || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean allowed(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
        return permissionGranted(context) && manager.areNotificationsEnabled()
            && (channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE);
    }

    static boolean enabled(Context context) {
        return PlanStore.preferences(context).getBoolean(PlanStore.SHADE_TIMER, false) && allowed(context);
    }

    static void syncStandalone(Context context, PlanState plan) {
        if (enabled(context)) post(context, plan);
        else context.getSystemService(NotificationManager.class).cancel(ID);
    }

    static void post(Context context, PlanState plan) {
        if (!enabled(context)) return;
        try {
            context.getSystemService(NotificationManager.class).notify(ID, build(context, plan, true));
            if (undoRefresh != null) MAIN.removeCallbacks(undoRefresh);
            if (PlanStore.canUndoFinish(PlanStore.read(context))) {
                Context app = context.getApplicationContext();
                undoRefresh = () -> post(app, PlanStore.readPlan(app));
                MAIN.postDelayed(undoRefresh, 8100);
            }
        } catch (SecurityException error) {
            Log.w("UspevatorNotification", "Cannot post plan notification", error);
        }
    }

    static Notification build(Context context, PlanState plan, boolean expanded) {
        Context localized = AppLanguage.forPlan(context, plan);
        String timerLabel = localized.getString(R.string.plan_timer);
        createChannel(context, timerLabel);
        String token = plan == null ? null : plan.token;
        boolean paused = plan != null && PlanState.PAUSED.equals(plan.phase());
        Notification.Builder builder = new Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.notification_icon)
            .setContentTitle(localized.getString(R.string.app_name))
            .setContentText(paused ? localized.getString(R.string.plan_paused) : timerLabel)
            .setCategory(Notification.CATEGORY_STATUS)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setOnlyAlertOnce(true).setOngoing(true).setShowWhen(false)
            .setContentIntent(PlanWidget.open(context, SURFACE, null, null));
        if (!expanded) {
            if (plan != null && plan.active()) {
                builder.addAction(new Notification.Action.Builder(null, localized.getString(paused ? R.string.resume : R.string.pause),
                    PlanWidget.control(context, SURFACE, paused ? "start" : "pause", token)).build());
                builder.addAction(new Notification.Action.Builder(null, localized.getString(plan.sound() ? R.string.mute_sound : R.string.unmute_sound),
                    PlanWidget.control(context, SURFACE, "sound", token)).build());
            }
            return builder.build();
        }

        long now = System.currentTimeMillis();
        PlanState.Snapshot view = PlanWidget.snapshot(plan, now);
        if (view.clock != null) {
            builder.setContentTitle(PlanWidget.shortText(view.task));
            builder.setContentText(paused ? localized.getString(R.string.pause) + " · " + PlanState.formatClock(view.clock.optimistic)
                + " / " + PlanState.formatClock(view.clock.guarded) : localized.getString(R.string.promised_time, PlanWidget.time(view.promise, now)));
            if (!paused) builder.setShowWhen(true).setUsesChronometer(true).setChronometerCountDown(true)
                .setWhen(now + view.clock.optimistic);
        } else if (PlanState.DONE.equals(view.phase)) {
            builder.setContentTitle(localized.getString(R.string.plan_complete))
                .setContentText(localized.getString(R.string.finished_time, PlanWidget.time(view.finishedAt, now)));
        } else if (view.hasPlan) {
            builder.setContentTitle(localized.getString(R.string.ready_to_start))
                .setContentText(localized.getString(R.string.buffered_finish_time, PlanWidget.time(view.promise, now)));
        } else builder.setContentText(localized.getString(R.string.no_tasks));

        Intent dismiss = new Intent(context, PlanWidget.class).setAction(DISMISS);
        builder.setDeleteIntent(PendingIntent.getBroadcast(context, ID, dismiss,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        builder.setCustomBigContentView(PlanWidget.shadeCard(localized, SURFACE, view, now, token));
        builder.setStyle(new Notification.DecoratedCustomViewStyle());
        if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return builder.build();
    }
}
