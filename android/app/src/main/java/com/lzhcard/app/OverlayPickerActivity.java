package com.lzhcard.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.core.content.FileProvider;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;

public class OverlayPickerActivity extends Activity {

    public static final String EXTRA_USE_CAMERA = "use_camera";
    private static final int REQ_GALLERY = 7101;
    private static final int REQ_CAMERA = 7102;

    private Uri cameraOutputUri;
    private File cameraOutputFile;
    private boolean resultDelivered = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        overridePendingTransition(0, 0);
        if (savedInstanceState == null) {
            boolean useCamera = getIntent() != null && getIntent().getBooleanExtra(EXTRA_USE_CAMERA, false);
            if (useCamera) {
                launchCamera();
            } else {
                launchGallery();
            }
        }
    }

    private void launchGallery() {
        try {
            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.setType("image/*");
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(Intent.createChooser(intent, "選擇圖片"), REQ_GALLERY);
        } catch (Exception e) {
            finishAndRestoreOverlay("");
        }
    }

    private void launchCamera() {
        try {
            cameraOutputFile = new File(getCacheDir(), "lzh_overlay_capture_" + System.currentTimeMillis() + ".jpg");
            cameraOutputUri = FileProvider.getUriForFile(
                this,
                getPackageName() + ".fileprovider",
                cameraOutputFile
            );
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, cameraOutputUri);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(intent, REQ_CAMERA);
        } catch (Exception e) {
            launchGallery();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK) {
            finishAndRestoreOverlay("");
            return;
        }

        Uri targetUri = null;
        if (requestCode == REQ_CAMERA) {
            targetUri = cameraOutputUri;
        } else if (requestCode == REQ_GALLERY && data != null) {
            targetUri = data.getData();
        }

        if (targetUri == null) {
            finishAndRestoreOverlay("");
            return;
        }

        final Uri finalUri = targetUri;
        new Thread(() -> {
            String base64 = encodeResizedJpegBase64(finalUri, 1920, 92);
            if (cameraOutputFile != null && cameraOutputFile.exists()) {
                try { cameraOutputFile.delete(); } catch (Exception ignored) {}
            }
            finishAndRestoreOverlay(base64 != null ? base64 : "");
        }).start();
    }

    private void finishAndRestoreOverlay(String base64) {
        if (!resultDelivered) {
            resultDelivered = true;
            FloatingOverlayService.deliverCapturedImageBase64(getApplicationContext(), base64);
        }
        runOnUiThread(() -> {
            finish();
            overridePendingTransition(0, 0);
        });
    }

    @Override
    protected void onDestroy() {
        if (!resultDelivered) {
            resultDelivered = true;
            FloatingOverlayService.deliverCapturedImageBase64(getApplicationContext(), "");
        }
        super.onDestroy();
    }

    private String encodeResizedJpegBase64(Uri uri, int maxDim, int quality) {
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            try (InputStream is1 = getContentResolver().openInputStream(uri)) {
                BitmapFactory.decodeStream(is1, null, bounds);
            }
            int srcW = bounds.outWidth;
            int srcH = bounds.outHeight;
            if (srcW <= 0 || srcH <= 0) return null;

            int inSample = 1;
            while ((srcW / inSample) > maxDim * 2 || (srcH / inSample) > maxDim * 2) {
                inSample *= 2;
            }

            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = inSample;
            Bitmap bmp;
            try (InputStream is2 = getContentResolver().openInputStream(uri)) {
                bmp = BitmapFactory.decodeStream(is2, null, opts);
            }
            if (bmp == null) return null;

            int rotation = readExifRotation(uri);
            if (rotation != 0) {
                Matrix m = new Matrix();
                m.postRotate(rotation);
                Bitmap rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
                if (rotated != bmp) bmp.recycle();
                bmp = rotated;
            }

            float scale = Math.min(1f, (float) maxDim / Math.max(bmp.getWidth(), bmp.getHeight()));
            if (scale < 1f) {
                int tw = Math.max(1, Math.round(bmp.getWidth() * scale));
                int th = Math.max(1, Math.round(bmp.getHeight() * scale));
                Bitmap scaled = Bitmap.createScaledBitmap(bmp, tw, th, true);
                if (scaled != bmp) bmp.recycle();
                bmp = scaled;
            }

            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, quality, baos);
            bmp.recycle();
            return Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }

    private int readExifRotation(Uri uri) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return 0;
        try (InputStream is = getContentResolver().openInputStream(uri)) {
            if (is == null) return 0;
            ExifInterface exif = new ExifInterface(is);
            int orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            if (orientation == ExifInterface.ORIENTATION_ROTATE_90) return 90;
            if (orientation == ExifInterface.ORIENTATION_ROTATE_180) return 180;
            if (orientation == ExifInterface.ORIENTATION_ROTATE_270) return 270;
        } catch (Exception ignored) {}
        return 0;
    }
}