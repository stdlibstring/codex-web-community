package dev.stdlibstring.codexremote;

import android.app.Activity;
import android.net.Uri;
import android.os.CancellationSignal;
import android.webkit.WebView;
import androidx.core.content.ContextCompat;
import androidx.credentials.CreateCredentialResponse;
import androidx.credentials.CreatePublicKeyCredentialRequest;
import androidx.credentials.CreatePublicKeyCredentialResponse;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPublicKeyCredentialOption;
import androidx.credentials.PublicKeyCredential;
import androidx.credentials.exceptions.CreateCredentialException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.Collections;

final class PasskeyBridge {
    private final Activity activity;
    private final WebView webView;
    private final CredentialManager manager;
    private CancellationSignal pending;

    PasskeyBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        manager = CredentialManager.create(activity);
        Uri server = Uri.parse(BuildConfig.SERVER_URL);
        String origin = server.getScheme() + "://" + server.getEncodedAuthority();
        WebViewCompat.addWebMessageListener(webView, "CodexPasskeys", Collections.singleton(origin),
                (view, message, sourceOrigin, mainFrame, reply) -> {
                    if (!mainFrame || !origin.equals(sourceOrigin.toString()) || view.getUrl() == null
                            || !("/".equals(Uri.parse(view.getUrl()).getPath())
                            || "/account/security".equals(Uri.parse(view.getUrl()).getPath()))) return;
                    JsonObject request = JsonParser.parseString(message.getData()).getAsJsonObject();
                    String id = request.get("id").getAsString();
                    String operation = request.get("operation").getAsString();
                    if (pending != null) {
                        failure(reply, id, "已有设备验证正在进行，请先完成或取消。", "BusyError");
                        return;
                    }
                    JsonObject options = request.getAsJsonObject("options");
                    String rpId = "register".equals(operation)
                            ? options.getAsJsonObject("rp").get("id").getAsString()
                            : options.get("rpId").getAsString();
                    if (!BuildConfig.PASSKEY_RP_ID.equals(rpId)) {
                        failure(reply, id, "通行密钥的服务域名与 APP 配置不符。", "SecurityError");
                        return;
                    }
                    pending = new CancellationSignal();
                    if ("register".equals(operation)) register(options.toString(), id, reply);
                    else if ("authenticate".equals(operation)) authenticate(options.toString(), id, reply);
                    else throw new IllegalArgumentException("未知的通行密钥操作。");
                });
    }

    private void register(String options, String id, JavaScriptReplyProxy reply) {
        manager.createCredentialAsync(activity, new CreatePublicKeyCredentialRequest(options), pending,
                ContextCompat.getMainExecutor(activity), new CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException>() {
                    @Override
                    public void onResult(CreateCredentialResponse result) {
                        pending = null;
                        if (!(result instanceof CreatePublicKeyCredentialResponse)) throw new IllegalStateException("系统返回了无法识别的通行密钥类型。");
                        success(reply, id, ((CreatePublicKeyCredentialResponse) result).getRegistrationResponseJson());
                    }

                    @Override
                    public void onError(CreateCredentialException error) {
                        pending = null;
                        failure(reply, id, "无法创建通行密钥：" + error.getMessage(), error.getClass().getSimpleName());
                    }
                });
    }

    private void authenticate(String options, String id, JavaScriptReplyProxy reply) {
        GetCredentialRequest request = new GetCredentialRequest.Builder()
                .addCredentialOption(new GetPublicKeyCredentialOption(options)).build();
        manager.getCredentialAsync(activity, request, pending, ContextCompat.getMainExecutor(activity),
                new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                    @Override
                    public void onResult(GetCredentialResponse result) {
                        pending = null;
                        if (!(result.getCredential() instanceof PublicKeyCredential)) throw new IllegalStateException("系统返回了无法识别的通行密钥类型。");
                        success(reply, id, ((PublicKeyCredential) result.getCredential()).getAuthenticationResponseJson());
                    }

                    @Override
                    public void onError(GetCredentialException error) {
                        pending = null;
                        failure(reply, id, "无法使用通行密钥：" + error.getMessage(), error.getClass().getSimpleName());
                    }
                });
    }

    private void success(JavaScriptReplyProxy reply, String id, String credential) {
        if (activity.isDestroyed()) return;
        JsonObject message = new JsonObject();
        message.addProperty("id", id);
        message.add("credential", JsonParser.parseString(credential));
        reply.postMessage(message.toString());
    }

    private void failure(JavaScriptReplyProxy reply, String id, String detail, String type) {
        if (activity.isDestroyed()) return;
        JsonObject message = new JsonObject();
        message.addProperty("id", id);
        message.addProperty("error", detail);
        message.addProperty("type", type);
        reply.postMessage(message.toString());
    }

    void close() {
        if (pending != null) pending.cancel();
        WebViewCompat.removeWebMessageListener(webView, "CodexPasskeys");
    }
}
