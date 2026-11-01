package dev.stdlibstring.codexremote;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.pm.PackageManager;
import android.util.Base64;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.google.android.gms.fido.Fido;
import com.google.android.gms.fido.fido2.api.common.PublicKeyCredentialCreationOptions;
import com.google.android.gms.tasks.Tasks;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class PasskeyAssociationTest {
    private final Context context = ApplicationProvider.getApplicationContext();
    private final OkHttpClient client = new OkHttpClient.Builder()
            .followRedirects(false).callTimeout(45, TimeUnit.SECONDS).build();

    @Test
    public void packagedStatementIsValidJson() throws Exception {
        String value = context.getString(R.string.asset_statements);
        JsonArray statements = JsonParser.parseString(value).getAsJsonArray();
        assertEquals(1, statements.size());
        assertEquals("https://" + BuildConfig.PASSKEY_RP_ID + "/.well-known/assetlinks.json",
                statements.get(0).getAsJsonObject().get("include").getAsString());
        assertEquals(R.string.asset_statements, context.getPackageManager()
                .getApplicationInfo(context.getPackageName(), PackageManager.GET_META_DATA)
                .metaData.getInt("asset_statements"));
    }

    @Test
    public void playServicesAcceptsRegistrationOptions() throws Exception {
        String encoded = InstrumentationRegistry.getArguments().getString("registrationOptionsBase64");
        assertNotNull("必须提供真实服务端生成的注册参数。", encoded);
        String options = new String(Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_PADDING), StandardCharsets.UTF_8);
        var pendingIntent = Tasks.await(Fido.getFido2ApiClient(context).getRegisterPendingIntent(
                new PublicKeyCredentialCreationOptions(options)), 60, TimeUnit.SECONDS);
        assertNotNull(pendingIntent);
    }

    @Test
    public void publicStatementMatchesInstalledSignature() throws Exception {
        JsonArray statements = getJson(HttpUrl.get("https://" + BuildConfig.PASSKEY_RP_ID
                + "/.well-known/assetlinks.json")).getAsJsonArray();
        boolean matched = false;
        for (var item : statements) {
            JsonObject statement = item.getAsJsonObject();
            JsonObject target = statement.getAsJsonObject("target");
            if (!target.get("package_name").getAsString().equals(context.getPackageName())) continue;
            assertTrue(statement.getAsJsonArray("relation").contains(
                    new com.google.gson.JsonPrimitive("delegate_permission/common.get_login_creds")));
            assertTrue(statement.getAsJsonArray("relation").contains(
                    new com.google.gson.JsonPrimitive("delegate_permission/common.handle_all_urls")));
            assertTrue(target.getAsJsonArray("sha256_cert_fingerprints").contains(
                    new com.google.gson.JsonPrimitive(fingerprint())));
            matched = true;
        }
        assertTrue("公开关联声明必须包含当前正式 APK 的签名。", matched);
    }

    @Test
    public void googleValidatesInstalledApp() throws Exception {
        HttpUrl url = HttpUrl.get("https://digitalassetlinks.googleapis.com/v1/assetlinks:check").newBuilder()
                .addQueryParameter("source.web.site", "https://" + BuildConfig.PASSKEY_RP_ID)
                .addQueryParameter("relation", "delegate_permission/common.get_login_creds")
                .addQueryParameter("target.android_app.package_name", context.getPackageName())
                .addQueryParameter("target.android_app.certificate.sha256_fingerprint", fingerprint()).build();
        JsonObject result = getJson(url).getAsJsonObject();
        assertTrue(result.toString(), result.has("linked") && result.get("linked").getAsBoolean());
    }

    private String fingerprint() throws Exception {
        byte[] certificate = context.getPackageManager().getPackageInfo(context.getPackageName(),
                PackageManager.GET_SIGNING_CERTIFICATES).signingInfo.getApkContentsSigners()[0].toByteArray();
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(certificate);
        StringBuilder value = new StringBuilder();
        for (byte part : digest) {
            if (value.length() > 0) value.append(':');
            value.append(String.format(Locale.ROOT, "%02X", part));
        }
        return value.toString();
    }

    private com.google.gson.JsonElement getJson(HttpUrl url) throws Exception {
        try (Response response = client.newCall(new Request.Builder().url(url).build()).execute()) {
            assertEquals(200, response.code());
            assertNotNull(response.body());
            assertEquals("application/json", response.body().contentType().type()
                    + "/" + response.body().contentType().subtype());
            return JsonParser.parseString(response.body().string());
        }
    }
}
