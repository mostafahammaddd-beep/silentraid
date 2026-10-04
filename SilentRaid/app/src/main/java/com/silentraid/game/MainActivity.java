package com.silentraid.game;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
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

    private static final long RETRY_LOAD_DELAY_MS = 30_000L;

    private WebView mWebView;
    private final Handler mHandler = new Handler(Looper.getMainLooper());
    private final boolean compatibilityRenderer = false; // hardware rendering on every API level

    // ---- rewarded ad state (main thread only) ----
    private boolean adsInitialized = false;
    private boolean adLoading = false;
    private boolean adShowing = false;
    private boolean destroyed = false;
    private RewardedAd rewardedAd = null;

    private final Runnable retryLoad = new Runnable() {
        @Override public void run() { loadRewardedAd(); }
    };

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        super.onCreate(savedInstanceState);
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

        // Real AdMob SDK. Never let an ads problem take the game down.
        try {
            MobileAds.initialize(this, initializationStatus -> mHandler.post(() -> {
                adsInitialized = true;
                loadRewardedAd();
            }));
        } catch (Throwable t) {
            adsInitialized = false;
        }

        mWebView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (mWebView != null) {
            mWebView.onResume();
            evaluate("if(typeof window.__silentRaidAppVisible === 'function') window.__silentRaidAppVisible();");
        }
        applyImmersiveSticky();
    }

    @Override
    protected void onPause() {
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

    private void loadRewardedAd() {
        if (destroyed || !adsInitialized || adLoading || adShowing || rewardedAd != null) return;
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
                            rewardedAd = ad;
                            pushRewardStatus("ready");
                        }

                        @Override
                        public void onAdFailedToLoad(@NonNull LoadAdError error) {
                            adLoading = false;
                            rewardedAd = null;
                            if (destroyed) return;
                            pushRewardStatus("load_failed:" + error.getCode());
                            mHandler.removeCallbacks(retryLoad);
                            mHandler.postDelayed(retryLoad, RETRY_LOAD_DELAY_MS);
                        }
                    });
        } catch (Throwable t) {
            adLoading = false;
            pushRewardStatus("not_ready");
        }
    }

    /** Called on the main thread when the page asks for a rewarded ad. */
    void onRewardAdRequested(final String purpose) {
        if (destroyed || adShowing) return;

        final RewardedAd ad = rewardedAd;
        if (ad == null) {
            pushRewardStatus(adLoading ? "loading" : "not_ready");
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
                    pushRewardStatus("show_failed");
                    loadRewardedAd();
                }
            });
            ad.show(this, rewardItem -> earned[0] = true);
        } catch (Throwable t) {
            adShowing = false;
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
