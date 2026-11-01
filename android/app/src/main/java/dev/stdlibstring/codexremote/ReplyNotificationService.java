package dev.stdlibstring.codexremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.CookieManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.RemoteInput;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.util.Objects;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.MediaType;
import okhttp3.Response;

public final class ReplyNotificationService extends Service {
    static final String REPLIES = "reply_completed";
    private static final String CONNECTION = "reply_connection";
    private static final String STOP = BuildConfig.APPLICATION_ID + ".STOP_NOTIFICATIONS";
    private static final String ANSWER = BuildConfig.APPLICATION_ID + ".ANSWER_QUESTION";
    private static final String RETRY = BuildConfig.APPLICATION_ID + ".RETRY_ANSWER";
    private static final String ANSWER_TEXT = "question_answer";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable polling = this::poll;
    private final OkHttpClient client = new OkHttpClient.Builder().callTimeout(45, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build();
    private Call request;
    private NotificationManager manager;
    private SharedPreferences settings;
    private boolean destroyed;
    private String connectionStatus;
    private final Set<String> sendingAnswers = new HashSet<>();

    static SharedPreferences settings(Context context) {
        return context.getSharedPreferences("reply_notifications", MODE_PRIVATE);
    }

    static boolean canNotify(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel channel = manager.getNotificationChannel(REPLIES);
        return manager.areNotificationsEnabled() && channel != null && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    static void createChannels(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel replies = new NotificationChannel(REPLIES, context.getString(R.string.reply_notifications), NotificationManager.IMPORTANCE_HIGH);
        replies.enableVibration(true);
        replies.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(replies);
        manager.createNotificationChannel(new NotificationChannel(CONNECTION, context.getString(R.string.notification_connection), NotificationManager.IMPORTANCE_LOW));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        settings = settings(this);
        manager = getSystemService(NotificationManager.class);
        createChannels(this);
        if (settings.getInt("questionNotificationVersion", 0) != 1) {
            settings.edit().remove("deliveredAttention").putInt("questionNotificationVersion", 1).apply();
        }
        JsonObject entries = outbox();
        for (var saved : entries.entrySet()) {
            JsonObject entry = saved.getValue().getAsJsonObject();
            if (entry.get("state").getAsString().equals("sending")) {
                entry.addProperty("state", "failed");
                entry.addProperty("error", getString(R.string.notification_answer_interrupted));
            }
        }
        settings.edit().putString("answerOutbox", entries.toString()).apply();
        if (settings.getBoolean("enabled", false) && canNotify(this)) {
            for (var saved : entries.entrySet()) {
                JsonObject entry = saved.getValue().getAsJsonObject();
                if (entry.get("state").getAsString().equals("failed")) {
                    manager.notify(saved.getKey(), 4, questionNotification(entry.getAsJsonObject("question")));
                }
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            settings.edit().putBoolean("enabled", false).remove("since").remove("cursor").remove("delivered").apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!settings.getBoolean("enabled", false) || !canNotify(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        Notification notification = connection(getString(R.string.notification_connecting));
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        else startForeground(1, notification);
        if (intent != null && (ANSWER.equals(intent.getAction()) || RETRY.equals(intent.getAction()))) {
            JsonObject question = JsonParser.parseString(Objects.requireNonNull(intent.getStringExtra("question"))).getAsJsonObject();
            String id = question.get("id").getAsString();
            String answer;
            if (ANSWER.equals(intent.getAction())) {
                var input = RemoteInput.getResultsFromIntent(intent);
                answer = Objects.requireNonNull(Objects.requireNonNull(input).getCharSequence(ANSWER_TEXT)).toString().trim();
            } else {
                answer = outbox().getAsJsonObject(id).get("answer").getAsString();
            }
            if (!answer.isEmpty()) sendAnswer(question, answer);
            else manager.notify(id, 4, questionNotification(question));
        }
        if (request == null) poll();
        return START_STICKY;
    }

    private PendingIntent openApp(String id) {
        return openApp(id, null, null);
    }

    private PendingIntent openApp(String id, String threadId, String cwd) {
        Intent intent = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.setData(Uri.parse("codexremote://notification/" + Uri.encode(id)));
        if (threadId != null) intent.putExtra("notificationThreadId", threadId).putExtra("notificationCwd", cwd);
        return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification connection(String text) {
        connectionStatus = text;
        PendingIntent stop = PendingIntent.getService(this, 0, new Intent(this, ReplyNotificationService.class).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CONNECTION).setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.reply_notifications)).setContentText(text)
                .setContentIntent(openApp("connection")).setOngoing(true).setSilent(true)
                .addAction(0, getString(R.string.notification_stop), stop).build();
    }

    private JsonObject outbox() {
        return JsonParser.parseString(settings.getString("answerOutbox", "{}")).getAsJsonObject();
    }

    private void saveAnswer(JsonObject question, String answer, String state, String error) {
        JsonObject entry = new JsonObject();
        entry.add("question", question);
        entry.addProperty("answer", answer);
        entry.addProperty("state", state);
        entry.addProperty("error", error);
        JsonObject entries = outbox();
        entries.add(question.get("id").getAsString(), entry);
        if (!settings.edit().putString("answerOutbox", entries.toString()).commit()) {
            throw new IllegalStateException("无法保存通知答案。");
        }
    }

    private PendingIntent answerIntent(JsonObject question, boolean retry) {
        String id = question.get("id").getAsString();
        Intent intent = new Intent(this, ReplyNotificationService.class).setAction(retry ? RETRY : ANSWER)
                .setData(Uri.parse("codexremote://answer/" + Uri.encode(id)))
                .putExtra("question", question.toString());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (retry ? PendingIntent.FLAG_IMMUTABLE : PendingIntent.FLAG_MUTABLE);
        return PendingIntent.getForegroundService(this, 0, intent, flags);
    }

    private Notification questionNotification(JsonObject question) {
        String id = question.get("id").getAsString();
        JsonObject entry = outbox().getAsJsonObject(id);
        String state = entry == null ? "ready" : entry.get("state").getAsString();
        String body = question.get("question").getAsString();
        StringBuilder expanded = new StringBuilder(body);
        for (var option : question.getAsJsonArray("options")) expanded.append("\n• ").append(option.getAsString());
        if (entry != null) {
            int label = switch (state) {
                case "sending" -> R.string.notification_answer_sending;
                case "sent" -> R.string.notification_answer_sent;
                case "failed", "resolved" -> R.string.notification_answer_failed;
                default -> throw new IllegalStateException("无法识别通知答案的发送状态。");
            };
            body = getString(label);
            expanded.append("\n\n").append(body).append("\n").append(entry.get("answer").getAsString());
            if (!entry.get("error").getAsString().isEmpty()) expanded.append("\n").append(entry.get("error").getAsString());
        }
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, REPLIES).setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(question.get("question").getAsString()).setSubText(question.get("title").getAsString()).setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(expanded))
                .setContentIntent(openApp(id, question.get("threadId").getAsString(), question.get("cwd").getAsString()))
                .setAutoCancel(true).setOnlyAlertOnce(true).setOngoing(state.equals("sending"))
                .setCategory(NotificationCompat.CATEGORY_MESSAGE).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setWhen(question.get("createdAt").getAsLong() * 1000);
        if (question.get("canReply").getAsBoolean() && (state.equals("ready") || state.equals("failed"))) {
            var options = question.getAsJsonArray("options");
            CharSequence[] choices = new CharSequence[options.size()];
            for (int index = 0; index < options.size(); index++) choices[index] = options.get(index).getAsString();
            RemoteInput input = new RemoteInput.Builder(ANSWER_TEXT).setLabel(getString(R.string.notification_answer_hint))
                    .setAllowFreeFormInput(true).setChoices(choices)
                    .setEditChoicesBeforeSending(RemoteInput.EDIT_CHOICES_BEFORE_SENDING_ENABLED).build();
            builder.addAction(new NotificationCompat.Action.Builder(0, getString(R.string.notification_answer), answerIntent(question, false))
                    .addRemoteInput(input).setAllowGeneratedReplies(false)
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY).setShowsUserInterface(false).build());
            if (state.equals("failed")) builder.addAction(0, getString(R.string.notification_answer_retry), answerIntent(question, true));
        }
        if (entry != null) builder.setRemoteInputHistory(new CharSequence[] { entry.get("answer").getAsString() });
        if (state.equals("sent")) builder.setTimeoutAfter(10_000);
        return builder.build();
    }

    private void finishAnswer(JsonObject question, String answer, String state, String error) {
        String id = question.get("id").getAsString();
        sendingAnswers.remove(id);
        saveAnswer(question, answer, state, error);
        manager.notify(id, 4, questionNotification(question));
    }

    private void sendAnswer(JsonObject question, String answer) {
        String id = question.get("id").getAsString();
        if (!sendingAnswers.add(id)) return;
        saveAnswer(question, answer, "sending", "");
        manager.notify(id, 4, questionNotification(question));
        String cookie = CookieManager.getInstance().getCookie(BuildConfig.SERVER_URL);
        if (cookie == null || cookie.isEmpty()) {
            finishAnswer(question, answer, "failed", getString(R.string.notification_answer_login));
            return;
        }
        JsonObject body = new JsonObject();
        body.addProperty("id", id);
        body.addProperty("answer", answer);
        Request submission = new Request.Builder().url(BuildConfig.SERVER_URL + "api/notifications/answer")
                .header("Cookie", cookie).post(RequestBody.create(body.toString(), MediaType.get("application/json; charset=utf-8"))).build();
        client.newCall(submission).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException error) {
                handler.post(() -> {
                    if (!destroyed) finishAnswer(question, answer, "failed", getString(R.string.notification_answer_network));
                });
            }

            @Override
            public void onResponse(Call call, Response response) throws IOException {
                try (Response received = response) {
                    int code = received.code();
                    if (received.isSuccessful()) {
                        JsonObject result = JsonParser.parseReader(Objects.requireNonNull(received.body()).charStream()).getAsJsonObject();
                        if (!result.get("ok").getAsBoolean()) throw new IllegalStateException("通知答案未被服务器接受。");
                    }
                    handler.post(() -> {
                        if (destroyed) return;
                        if (code >= 200 && code < 300) finishAnswer(question, answer, "sent", "");
                        else if (code == 401) finishAnswer(question, answer, "failed", getString(R.string.notification_answer_login));
                        else if (code == 409) finishAnswer(question, answer, "resolved", getString(R.string.notification_answer_resolved));
                        else finishAnswer(question, answer, "failed", getString(R.string.http_error, code));
                    });
                }
            }
        });
    }

    private void status(int text) {
        status(getString(text));
    }

    private void status(String value) {
        if (!value.equals(connectionStatus)) manager.notify(1, connection(value));
    }

    private void poll() {
        if (destroyed) return;
        handler.removeCallbacks(polling);
        if (!settings.getBoolean("enabled", false) || !canNotify(this)) { stopSelf(); return; }
        String cookie = CookieManager.getInstance().getCookie(BuildConfig.SERVER_URL);
        if (cookie == null || cookie.isEmpty()) { loginRequired(); return; }
        Uri.Builder url = Uri.parse(BuildConfig.SERVER_URL + "api/notifications").buildUpon();
        if (settings.contains("since")) {
            url.appendQueryParameter("since", Long.toString(settings.getLong("since", 0)))
                    .appendQueryParameter("after", Long.toString(settings.getLong("cursor", 0)));
        }
        request = client.newCall(new Request.Builder().url(url.build().toString()).header("Cookie", cookie).build());
        request.enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException error) {
                handler.post(() -> {
                    if (destroyed) return;
                    request = null;
                    status(R.string.notification_disconnected);
                    handler.postDelayed(polling, 15_000);
                });
            }

            @Override
            public void onResponse(Call call, Response response) {
                try (Response received = response) {
                    int code = received.code();
                    if (code == 401) { handler.post(() -> { if (!destroyed) loginRequired(); }); return; }
                    if (!received.isSuccessful()) {
                        handler.post(() -> {
                            if (destroyed) return;
                            request = null;
                            status(getString(R.string.http_error, code));
                            handler.postDelayed(polling, 15_000);
                        });
                        return;
                    }
                    JsonObject batch = JsonParser.parseReader(Objects.requireNonNull(received.body()).charStream()).getAsJsonObject();
                    handler.post(() -> { if (!destroyed) deliver(batch); });
                }
            }
        });
    }

    private void loginRequired() {
        Notification notification = new NotificationCompat.Builder(this, CONNECTION).setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.reply_notifications)).setContentText(getString(R.string.notification_login))
                .setContentIntent(openApp("login")).setAutoCancel(true).build();
        stopForeground(STOP_FOREGROUND_REMOVE);
        manager.notify(3, notification);
        stopSelf();
    }

    private void deliver(JsonObject batch) {
        request = null;
        if (!settings.getBoolean("enabled", false) || !canNotify(this)) { stopSelf(); return; }
        long cursor = batch.get("cursor").getAsLong();
        JsonObject delivered = JsonParser.parseString(settings.getString("delivered", "{}")).getAsJsonObject();
        for (var value : batch.getAsJsonArray("replies")) {
            JsonObject reply = value.getAsJsonObject();
            String id = reply.get("id").getAsString();
            if (delivered.has(id)) continue;
            Notification notification = new NotificationCompat.Builder(this, REPLIES).setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(reply.get("title").getAsString()).setContentText(getString(R.string.notification_ready))
                    .setContentIntent(openApp(id, reply.get("threadId").getAsString(), reply.get("cwd").getAsString()))
                    .setAutoCancel(true).setOnlyAlertOnce(true)
                    .setCategory(NotificationCompat.CATEGORY_MESSAGE).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .setWhen(reply.get("completedAt").getAsLong() * 1000).build();
            manager.notify(id, 2, notification);
            delivered.addProperty(id, reply.get("completedAt").getAsLong());
        }
        delivered.entrySet().removeIf(entry -> entry.getValue().getAsLong() < cursor - 120);
        JsonObject previousAttention = JsonParser.parseString(settings.getString("deliveredAttention", "{}")).getAsJsonObject();
        JsonObject currentAttention = new JsonObject();
        for (var value : batch.getAsJsonArray("attention")) {
            JsonObject attention = value.getAsJsonObject();
            String id = attention.get("id").getAsString();
            currentAttention.addProperty(id, true);
            if (previousAttention.has(id)) continue;
            if (attention.get("kind").getAsString().equals("question")) {
                JsonObject entry = outbox().getAsJsonObject(id);
                if (entry != null && entry.get("state").getAsString().equals("sending") && !sendingAnswers.contains(id)) {
                    saveAnswer(attention, entry.get("answer").getAsString(), "failed", getString(R.string.notification_answer_interrupted));
                }
                manager.notify(id, 4, questionNotification(attention));
                continue;
            }
            int text = switch (attention.get("kind").getAsString()) {
                case "approval" -> R.string.notification_approval;
                case "question" -> R.string.notification_question;
                default -> throw new IllegalArgumentException("无法识别需要处理的通知类型。");
            };
            Notification notification = new NotificationCompat.Builder(this, REPLIES).setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(attention.get("title").getAsString()).setContentText(getString(text))
                    .setContentIntent(openApp(id, attention.get("threadId").getAsString(), attention.get("cwd").getAsString()))
                    .setAutoCancel(true).setOnlyAlertOnce(true)
                    .setCategory(NotificationCompat.CATEGORY_REMINDER).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .setWhen(attention.get("createdAt").getAsLong() * 1000).build();
            manager.notify(id, 4, notification);
        }
        for (String id : previousAttention.keySet()) {
            if (!currentAttention.has(id) && !sendingAnswers.contains(id)) manager.cancel(id, 4);
        }
        JsonObject entries = outbox();
        entries.entrySet().removeIf(entry -> !currentAttention.has(entry.getKey()) && !sendingAnswers.contains(entry.getKey())
                && entry.getValue().getAsJsonObject().get("state").getAsString().equals("sent"));
        if (!settings.edit().putLong("since", settings.getLong("since", cursor)).putLong("cursor", cursor)
                .putString("delivered", delivered.toString()).putString("deliveredAttention", currentAttention.toString())
                .putString("answerOutbox", entries.toString())
                .commit()) throw new IllegalStateException("无法保存通知接收进度。");
        manager.cancel(3);
        status(R.string.notification_connected);
        handler.postDelayed(polling, 5000);
    }

    @Override
    public void onDestroy() {
        destroyed = true;
        handler.removeCallbacksAndMessages(null);
        if (!settings.getBoolean("enabled", false)) {
            for (var notification : manager.getActiveNotifications()) {
                if (notification.getId() == 4) manager.cancel(notification.getTag(), 4);
            }
            settings.edit().remove("deliveredAttention").apply();
        }
        client.dispatcher().executorService().execute(() -> {
            client.dispatcher().cancelAll();
            client.connectionPool().evictAll();
        });
        client.dispatcher().executorService().shutdown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
