package com.lzhcard.app;

import android.app.Activity;
import android.content.Context;
import android.text.TextUtils;

import androidx.annotation.NonNull;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.ConsumeParams;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

@CapacitorPlugin(name = "PlayBilling")
public class PlayBillingPlugin extends Plugin implements PurchasesUpdatedListener {

    private BillingClient billingClient;
    private PluginCall pendingPurchaseCall = null;
    private String pendingPurchaseProductId = "";

    private void ensureBillingClient() {
        if (billingClient != null) return;
        Context ctx = getContext();
        if (ctx == null) return;
        billingClient = BillingClient.newBuilder(ctx)
            .setListener(this)
            .enablePendingPurchases(
                PendingPurchasesParams.newBuilder()
                    .enableOneTimeProducts()
                    .build()
            )
            .build();
    }

    private void withConnectedBilling(Runnable onReady, PluginCall errorCall) {
        ensureBillingClient();
        if (billingClient == null) {
            if (errorCall != null) errorCall.reject("BillingClient unavailable");
            return;
        }
        if (billingClient.isReady()) {
            onReady.run();
            return;
        }
        billingClient.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(@NonNull BillingResult billingResult) {
                if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    onReady.run();
                } else if (errorCall != null) {
                    errorCall.reject("Billing connection failed: " + billingResult.getDebugMessage());
                }
            }

            @Override
            public void onBillingServiceDisconnected() {
                // Next call will reconnect automatically via isReady() check
            }
        });
    }

    private JSObject purchaseToJson(Purchase p) {
        JSObject obj = new JSObject();
        obj.put("orderId", p.getOrderId() != null ? p.getOrderId() : "");
        obj.put("purchaseToken", p.getPurchaseToken());
        obj.put("packageName", p.getPackageName());
        obj.put("purchaseTime", p.getPurchaseTime());
        obj.put("purchaseState", p.getPurchaseState());
        obj.put("acknowledged", p.isAcknowledged());
        JSArray products = new JSArray();
        for (String prod : p.getProducts()) {
            products.put(prod);
        }
        obj.put("products", products);
        obj.put("productId", p.getProducts().isEmpty() ? "" : p.getProducts().get(0));
        return obj;
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        withConnectedBilling(() -> {
            JSObject ret = new JSObject();
            ret.put("available", true);
            ret.put("packageName", getContext() != null ? getContext().getPackageName() : "com.lzhcard.app");
            call.resolve(ret);
        }, call);
    }

    @PluginMethod
    public void queryProducts(PluginCall call) {
        JSArray skusArr = call.getArray("productIds");
        if (skusArr == null || skusArr.length() == 0) {
            JSObject ret = new JSObject();
            ret.put("products", new JSArray());
            call.resolve(ret);
            return;
        }

        List<QueryProductDetailsParams.Product> productList = new ArrayList<>();
        for (int i = 0; i < skusArr.length(); i++) {
            String pid = skusArr.optString(i, "").trim();
            if (!pid.isEmpty()) {
                productList.add(
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(pid)
                        .setProductType(BillingClient.ProductType.INAPP)
                        .build()
                );
            }
        }
        if (productList.isEmpty()) {
            JSObject ret = new JSObject();
            ret.put("products", new JSArray());
            call.resolve(ret);
            return;
        }

        withConnectedBilling(() -> {
            QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
                .setProductList(productList)
                .build();
            billingClient.queryProductDetailsAsync(params, (billingResult, detailsList) -> {
                if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    call.reject("Query products failed: " + billingResult.getDebugMessage());
                    return;
                }
                JSArray out = new JSArray();
                if (detailsList != null) {
                    for (ProductDetails d : detailsList) {
                        JSObject item = new JSObject();
                        item.put("productId", d.getProductId());
                        item.put("title", d.getTitle());
                        item.put("description", d.getDescription());
                        ProductDetails.OneTimePurchaseOfferDetails offer = d.getOneTimePurchaseOfferDetails();
                        if (offer != null) {
                            item.put("formattedPrice", offer.getFormattedPrice());
                            item.put("priceCurrencyCode", offer.getPriceCurrencyCode());
                            item.put("priceAmountMicros", offer.getPriceAmountMicros());
                        }
                        out.put(item);
                    }
                }
                JSObject ret = new JSObject();
                ret.put("products", out);
                call.resolve(ret);
            });
        }, call);
    }

    @PluginMethod
    public void purchaseProduct(PluginCall call) {
        String productId = call.getString("productId", "").trim();
        if (TextUtils.isEmpty(productId)) {
            call.reject("Missing productId");
            return;
        }
        if (pendingPurchaseCall != null) {
            call.reject("Purchase already in progress");
            return;
        }

        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity unavailable");
            return;
        }

        pendingPurchaseCall = call;
        pendingPurchaseProductId = productId;

        withConnectedBilling(() -> {
            List<QueryProductDetailsParams.Product> prodList = Collections.singletonList(
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(productId)
                    .setProductType(BillingClient.ProductType.INAPP)
                    .build()
            );
            QueryProductDetailsParams queryParams = QueryProductDetailsParams.newBuilder()
                .setProductList(prodList)
                .build();

            billingClient.queryProductDetailsAsync(queryParams, (billingResult, detailsList) -> {
                if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK || detailsList == null || detailsList.isEmpty()) {
                    PluginCall c = pendingPurchaseCall;
                    pendingPurchaseCall = null;
                    pendingPurchaseProductId = "";
                    if (c != null) {
                        c.reject("找不到商品或尚未在 Google Play Console 上架 (" + productId + ")");
                    }
                    return;
                }

                ProductDetails targetDetails = detailsList.get(0);
                List<BillingFlowParams.ProductDetailsParams> flowProducts = Collections.singletonList(
                    BillingFlowParams.ProductDetailsParams.newBuilder()
                        .setProductDetails(targetDetails)
                        .build()
                );
                BillingFlowParams flowParams = BillingFlowParams.newBuilder()
                    .setProductDetailsParamsList(flowProducts)
                    .build();

                activity.runOnUiThread(() -> {
                    BillingResult launchRes = billingClient.launchBillingFlow(activity, flowParams);
                    if (launchRes.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                        PluginCall c = pendingPurchaseCall;
                        pendingPurchaseCall = null;
                        pendingPurchaseProductId = "";
                        if (c != null) {
                            c.reject("無法開啟 Google Play 付款畫面: " + launchRes.getDebugMessage());
                        }
                    }
                });
            });
        }, new PluginCall(null, null, null, null, null) {
            @Override
            public void reject(String msg) {
                PluginCall c = pendingPurchaseCall;
                pendingPurchaseCall = null;
                pendingPurchaseProductId = "";
                if (c != null) c.reject(msg);
            }
        });
    }

    @Override
    public void onPurchasesUpdated(@NonNull BillingResult billingResult, List<Purchase> purchases) {
        PluginCall call = pendingPurchaseCall;
        String targetSku = pendingPurchaseProductId;
        pendingPurchaseCall = null;
        pendingPurchaseProductId = "";

        if (call == null) return;

        int code = billingResult.getResponseCode();
        if (code == BillingClient.BillingResponseCode.USER_CANCELED) {
            call.reject("已取消購買");
            return;
        }
        if (code != BillingClient.BillingResponseCode.OK || purchases == null || purchases.isEmpty()) {
            call.reject("Google Play 交易未完成 (" + code + "): " + billingResult.getDebugMessage());
            return;
        }

        Purchase matched = null;
        for (Purchase p : purchases) {
            if (p != null && (targetSku.isEmpty() || p.getProducts().contains(targetSku))) {
                matched = p;
                break;
            }
        }
        if (matched == null) matched = purchases.get(0);

        if (matched.getPurchaseState() == Purchase.PurchaseState.PENDING) {
            call.reject("交易待處理中，請於完成付款後重新進入方案頁面");
            return;
        }
        if (matched.getPurchaseState() != Purchase.PurchaseState.PURCHASED) {
            call.reject("交易尚未完成授權");
            return;
        }

        call.resolve(purchaseToJson(matched));
    }

    @PluginMethod
    public void consumePurchase(PluginCall call) {
        String purchaseToken = call.getString("purchaseToken", "").trim();
        if (TextUtils.isEmpty(purchaseToken)) {
            call.reject("Missing purchaseToken");
            return;
        }
        withConnectedBilling(() -> {
            ConsumeParams params = ConsumeParams.newBuilder()
                .setPurchaseToken(purchaseToken)
                .build();
            billingClient.consumeAsync(params, (result, token) -> {
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    JSObject ret = new JSObject();
                    ret.put("consumed", true);
                    ret.put("purchaseToken", token);
                    call.resolve(ret);
                } else {
                    call.reject("Consume failed: " + result.getDebugMessage());
                }
            });
        }, call);
    }

    @PluginMethod
    public void acknowledgePurchase(PluginCall call) {
        String purchaseToken = call.getString("purchaseToken", "").trim();
        if (TextUtils.isEmpty(purchaseToken)) {
            call.reject("Missing purchaseToken");
            return;
        }
        withConnectedBilling(() -> {
            AcknowledgePurchaseParams params = AcknowledgePurchaseParams.newBuilder()
                .setPurchaseToken(purchaseToken)
                .build();
            billingClient.acknowledgePurchase(params, result -> {
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    JSObject ret = new JSObject();
                    ret.put("acknowledged", true);
                    call.resolve(ret);
                } else {
                    call.reject("Acknowledge failed: " + result.getDebugMessage());
                }
            });
        }, call);
    }

    @PluginMethod
    public void queryPendingPurchases(PluginCall call) {
        withConnectedBilling(() -> {
            QueryPurchasesParams params = QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.INAPP)
                .build();
            billingClient.queryPurchasesAsync(params, (result, purchasesList) -> {
                if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    call.reject("Query purchases failed: " + result.getDebugMessage());
                    return;
                }
                JSArray arr = new JSArray();
                if (purchasesList != null) {
                    for (Purchase p : purchasesList) {
                        if (p != null && p.getPurchaseState() == Purchase.PurchaseState.PURCHASED) {
                            arr.put(purchaseToJson(p));
                        }
                    }
                }
                JSObject ret = new JSObject();
                ret.put("purchases", arr);
                call.resolve(ret);
            });
        }, call);
    }

    @Override
    protected void handleOnDestroy() {
        if (billingClient != null) {
            try {
                billingClient.endConnection();
            } catch (Exception ignored) {}
            billingClient = null;
        }
        super.handleOnDestroy();
    }
}
