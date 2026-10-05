package com.silentraid.game;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;

import com.google.android.gms.ads.AdError;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.FullScreenContentCallback;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.MobileAds;
import com.google.android.gms.ads.ResponseInfo;
import com.google.android.gms.ads.rewarded.RewardedAd;
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback;

/**
 * Silent Raid host activity: a full-screen WebView that loads the bundled HTML5 game
 * and exposes two JavaScript bridges:
 *   - SilentRaidDevice.isLegacyRenderer()
 *   - SilentRaidAds.showRewarded(purpose)   -> real AdMob rewarded ad
 *
 * The game is only rewarded (window.onNativeRewardAdEarned) after AdMob's
 * OnUserEarnedRewardListener fires and the ad has been closed, exactly once per ad.
 */
public class MainActivity extends Activity {

    private static final String TAG = "SilentRaidAds";

    /** Back-off between automatic reload attempts after a failed load. */
    private static final long[] RETRY_DELAYS_MS = { 3_000L, 8_000L, 20_000L, 45_000L, 60_000L };
    /** How long a tapped "watch ad" button waits for an ad that is still loading. */
    private static final long PENDING_WAIT_MS = 25_000L;
    /** If the SDK's init callback never arrives, try loading anyway after this long. */
    private static final long INIT_FALLBACK_MS = 8_000L;

    private WebView mWebView;
    private final Handler mHandler = new Handler(Looper.getMainLooper());
    private final boolean compatibilityRenderer = false; // hardware rendering on every API level

    // ---- rewarded ad state (main thread only) ----
    private boolean adsInitialized = false;
    private boolean initFallbackFired = false;
    private boolean adLoading = false;
    private boolean adShowing = false;
    private boolean destroyed = false;
    private boolean resumed = false;
    private int loadFailures = 0;
    private RewardedAd rewardedAd = null;
    /** Purpose of a button tap that arrived before an ad was ready; shown as soon as one loads. */
    private String pendingPurpose = null;

    private final Runnable retryLoad = new Runnable() {
        @Override public void run() { loadRewardedAd(); }
    };

    private final Runnable initFallback = new Runnable() {
        @Override public void run() {
            if (!adsInitialized) {
                initFallbackFired = true;
                loadRewardedAd();
            }
        }
    };

    private final Runnable pendingTimeout = new Runnable() {
        @Override public void run() {
            if (pendingPurpose != null) {
                pendingPurpose = null;
                pushRewardStatus("not_ready");
            }
        }
    };

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        super.onCreate(savedInstanceState);
        // Start the AdMob SDK before the heavy game WebView is built so its own
        // initialisation does not compete with the game's asset loading.
        startAds();
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        mWebView = new WebView(this);
        mWebView.setBackgroundColor(Color.BLACK);
        mWebView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        if (compatibilityRenderer) {
            mWebView.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        } else {
            mWebView.setLayerType(View.LAYER_TYPE_NONE, null);
        }

        WebSettings s = mWebView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setOffscreenPreRaster(true);

        mWebView.setWebChromeClient(new WebChromeClient());
        mWebView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // Tell the page the current ad state and make sure one is loading.
                pushRewardStatus(rewardedAd != null ? "ready" : "loading");
                loadRewardedAd();
            }
        });

        mWebView.addJavascriptInterface(new SilentRaidDeviceBridge(compatibilityRenderer), "SilentRaidDevice");
        mWebView.addJavascriptInterface(new SilentRaidAdsBridge(this), "SilentRaidAds");

        root.addView(mWebView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        applyImmersiveSticky();

        mWebView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        // Coming back from the background: make sure an ad is on its way, and honour a
        // button tap that was waiting for one.
        if (rewardedAd != null && pendingPurpose != null && !adShowing) {
            String waiting = pendingPurpose;
            clearPending();
            showRewardedNow(waiting);
        } else if (rewardedAd == null && !adLoading && !adShowing) {
            mHandler.removeCallbacks(retryLoad);
            loadRewardedAd();
        }
        if (mWebView != null) {
            mWebView.onResume();
            evaluate("if(typeof window.__silentRaidAppVisible === 'function') window.__silentRaidAppVisible();");
        }
        applyImmersiveSticky();
    }

    @Override
    protected void onPause() {
        resumed = false;
        if (mWebView != null) {
            evaluate("if(typeof window.__silentRaidAppHidden === 'function') window.__silentRaidAppHidden();");
            mWebView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        mHandler.removeCallbacksAndMessages(null);
        pendingPurpose = null;
        rewardedAd = null;
        if (mWebView != null) {
            mWebView.destroy();
            mWebView = null;
        }
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersiveSticky();
    }

    @Override
    public void onBackPressed() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.exit_title)
                .setMessage(R.string.exit_message)
                .setPositiveButton(R.string.exit_yes, (dialog, which) -> finish())
                .setNegativeButton(R.string.exit_no, (dialog, which) -> {
                    dialog.dismiss();
                    applyImmersiveSticky();
                })
                .show();
    }

    @SuppressWarnings("deprecation")
    private void applyImmersiveSticky() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    // ------------------------------------------------------------------ JS helpers

    private void evaluate(String js) {
        if (destroyed || mWebView == null) return;
        try {
            mWebView.evaluateJavascript(js, null);
        } catch (Throwable ignored) { }
    }

    private void pushRewardStatus(String status) {
        evaluate("if (typeof window.onNativeRewardAdStatus === 'function') { window.onNativeRewardAdStatus('"
                + sanitize(status) + "'); }");
    }

    private void deliverReward(String purpose) {
        evaluate("if (typeof window.onNativeRewardAdEarned === 'function') { window.onNativeRewardAdEarned('"
                + sanitize(purpose) + "'); }");
    }

    /** Only letters, digits, '_' ':' '-' reach the page. */
    private static String sanitize(String v) {
        if (v == null) return "";
        return v.replaceAll("[^A-Za-z0-9_:\\-]", "");
    }

    // ------------------------------------------------------------------ rewarded ads (real AdMob)

    /** Initialise the SDK off the main thread (Google's recommendation) and start loading. */
    private void startAds() {
        try {
            new Thread(new Runnable() {
                @Override public void run() {
                    try {
                        MobileAds.initialize(MainActivity.this, initializationStatus -> mHandler.post(() -> {
                            adsInitialized = true;
                            mHandler.removeCallbacks(initFallback);
                            loadRewardedAd();
                        }));
                    } catch (Throwable t) {
                        Log.w(TAG, "MobileAds.initialize failed", t);
                    }
                }
            }, "silentraid-ads-init").start();
        } catch (Throwable t) {
            Log.w(TAG, "could not start ads init thread", t);
        }
        // Never depend on a single callback: if it is late or lost, still try to load.
        mHandler.postDelayed(initFallback, INIT_FALLBACK_MS);
    }

    private boolean isOnline() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            Network network = cm.getActiveNetwork();
            if (network == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(network);
            return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (Throwable t) {
            return true; // when in doubt, let the SDK try
        }
    }

    /** Short, page-safe description of why a load failed (code + the SDK's own message/cause). */
    private static String describeLoadError(LoadAdError error) {
        StringBuilder sb = new StringBuilder();
        try {
            String msg = error.getMessage();
            if (msg != null) sb.append(msg);
            AdError cause = error.getCause();
            if (cause != null && cause.getMessage() != null) sb.append(' ').append(cause.getMessage());
            ResponseInfo info = error.getResponseInfo();
            if (info != null && info.getResponseId() != null) sb.append(" id ").append(info.getResponseId());
        } catch (Throwable ignored) { }
        String reason = sb.toString().replaceAll("[^A-Za-z0-9]+", "_");
        if (reason.length() > 80) reason = reason.substring(0, 80);
        return reason;
    }

    private void scheduleRetry() {
        if (destroyed) return;
        int idx = Math.max(0, Math.min(loadFailures - 1, RETRY_DELAYS_MS.length - 1));
        mHandler.removeCallbacks(retryLoad);
        mHandler.postDelayed(retryLoad, RETRY_DELAYS_MS[idx]);
    }

    /** A waiting button tap can no longer be satisfied: drop it (the failure status is pushed by the caller). */
    private void clearPending() {
        pendingPurpose = null;
        mHandler.removeCallbacks(pendingTimeout);
    }

    private void loadRewardedAd() {
        if (destroyed || !(adsInitialized || initFallbackFired)) return;
        if (adLoading || adShowing || rewardedAd != null) return;

        if (!isOnline()) {
            loadFailures++;
            clearPending();
            pushRewardStatus("offline");
            scheduleRetry();
            return;
        }

        adLoading = true;
        pushRewardStatus("loading");
        try {
            RewardedAd.load(this, getString(R.string.admob_rewarded_unit_id),
                    new AdRequest.Builder().build(),
                    new RewardedAdLoadCallback() {
                        @Override
                        public void onAdLoaded(@NonNull RewardedAd ad) {
                            adLoading = false;
                            if (destroyed) return;
                            loadFailures = 0;
                            mHandler.removeCallbacks(retryLoad);
                            rewardedAd = ad;
                            if (pendingPurpose != null && resumed) {
                                // The player already tapped the button: show right away.
                                String purpose = pendingPurpose;
                                clearPending();
                                showRewardedNow(purpose);
                            } else {
                                pushRewardStatus("ready");
                            }
                        }

                        @Override
                        public void onAdFailedToLoad(@NonNull LoadAdError error) {
                            adLoading = false;
                            rewardedAd = null;
                            Log.w(TAG, "Rewarded ad failed to load: " + error);
                            if (destroyed) return;
                            loadFailures++;
                            clearPending();
                            pushRewardStatus("load_failed:" + error.getCode() + ":" + describeLoadError(error));
                            scheduleRetry();
                        }
                    });
        } catch (Throwable t) {
            adLoading = false;
            Log.w(TAG, "RewardedAd.load threw", t);
            loadFailures++;
            clearPending();
            pushRewardStatus("not_ready");
            scheduleRetry();
        }
    }

    /** Called on the main thread when the page asks for a rewarded ad. */
    void onRewardAdRequested(final String purpose) {
        if (destroyed || adShowing) return;

        if (rewardedAd != null) {
            showRewardedNow(purpose);
            return;
        }

        // No ad ready yet: remember the tap, make sure a load is running, and show as soon as it lands.
        pendingPurpose = purpose;
        mHandler.removeCallbacks(pendingTimeout);
        mHandler.postDelayed(pendingTimeout, PENDING_WAIT_MS);
        pushRewardStatus("loading");
        if (!adLoading) {
            mHandler.removeCallbacks(retryLoad);
            loadRewardedAd();
        }
    }

    private void showRewardedNow(final String purpose) {
        final RewardedAd ad = rewardedAd;
        if (ad == null) {
            pushRewardStatus("not_ready");
            loadRewardedAd();
            return;
        }

        // Consume the ad object now: a loaded ad can only ever be shown (and rewarded) once.
        rewardedAd = null;
        adShowing = true;
        final boolean[] earned = { false };

        try {
            ad.setFullScreenContentCallback(new FullScreenContentCallback() {
                @Override
                public void onAdDismissedFullScreenContent() {
                    adShowing = false;
                    if (earned[0]) {
                        earned[0] = false; // never pay the same ad twice
                        deliverReward(purpose);
                    } else {
                        pushRewardStatus("not_ready"); // closed early: no reward
                    }
                    loadRewardedAd();
                }

                @Override
                public void onAdFailedToShowFullScreenContent(@NonNull AdError adError) {
                    adShowing = false;
                    Log.w(TAG, "Rewarded ad failed to show: " + adError);
                    pushRewardStatus("show_failed");
                    loadRewardedAd();
                }
            });
            ad.show(this, rewardItem -> earned[0] = true);
        } catch (Throwable t) {
            adShowing = false;
            Log.w(TAG, "RewardedAd.show threw", t);
            pushRewardStatus("show_failed");
            loadRewardedAd();
        }
    }

    // ------------------------------------------------------------------ JS bridges

    static class SilentRaidAdsBridge {
        private final MainActivity mActivity;

        SilentRaidAdsBridge(MainActivity activity) { this.mActivity = activity; }

        @JavascriptInterface
        public void showRewarded(final String purpose) {
            mActivity.mHandler.post(() -> mActivity.onRewardAdRequested(purpose));
        }
    }

    static class SilentRaidDeviceBridge {
        private final boolean compatibilityRenderer;

        SilentRaidDeviceBridge(boolean compatibilityRenderer) {
            this.compatibilityRenderer = compatibilityRenderer;
        }

        @JavascriptInterface
        public boolean isLegacyRenderer() { return compatibilityRenderer; }
    }
}
