package com.bloomfieldinnovations.unirp

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.MediaStore
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewAssetLoader.AssetsPathHandler
import java.io.File

/**
 * Single-activity WebView host for the FIRE Assessment + INDRIYA Smart Campus
 * Audit. The exact same HTML/JS that runs on the web is bundled into the APK
 * (see the syncWebAssets Gradle task), so scoring, the ROI calculator, the OTP
 * gate, IndexedDB draft persistence and free navigation all behave identically
 * — there is no second implementation to keep in sync.
 *
 * Native glue provided here:
 *   - serves the bundled site over https://appassets.androidplatform.net so
 *     IndexedDB has a stable, secure-context origin that survives relaunches;
 *   - wires <input type="file" accept="image/*" capture> to the camera + gallery;
 *   - routes the report's window.print() to the Android print framework;
 *   - points sample-reference images at the public host so the server-side PDF
 *     can still fetch them.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var cameraImageUri: Uri? = null

    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            deliverFileChooserResult(result)
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/", AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            with(settings) {
                javaScriptEnabled = true
                domStorageEnabled = true        // localStorage / sessionStorage
                databaseEnabled = true          // IndexedDB-backed drafts persist
                javaScriptCanOpenWindowsAutomatically = true
                loadWithOverviewMode = true
                useWideViewPort = true
                allowFileAccess = false         // not needed — we serve via the asset loader
                allowContentAccess = false
            }

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

                override fun onPageFinished(view: WebView, url: String?) {
                    // Set the public asset base (for the server PDF) and bridge
                    // the in-report download button to the Android print stack.
                    view.evaluateJavascript(
                        "window.SAMPLE_IMG_BASE='" + HOSTED_ASSET_BASE + "';" +
                            "window.print=function(){try{AndroidPrint.printPage();}catch(e){}};",
                        null
                    )
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    webView: WebView,
                    callback: ValueCallback<Array<Uri>>,
                    params: FileChooserParams
                ): Boolean {
                    filePathCallback?.onReceiveValue(null)
                    filePathCallback = callback
                    return openImageChooser(params)
                }
            }

            addJavascriptInterface(PrintBridge(), "AndroidPrint")
        }

        setContentView(webView)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        if (savedInstanceState == null) {
            webView.loadUrl(START_URL)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        webView.restoreState(savedInstanceState)
    }

    /** Offer camera capture + gallery for the page's <input type="file"> request. */
    private fun openImageChooser(params: WebChromeClient.FileChooserParams): Boolean {
        return try {
            val allowMultiple =
                params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE

            val galleryIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                type = "image/*"
                addCategory(Intent.CATEGORY_OPENABLE)
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple)
            }

            val cameraIntents = ArrayList<Intent>()
            val captureFile = File.createTempFile("indriya_", ".jpg", cacheDir)
            cameraImageUri = FileProvider.getUriForFile(
                this, "$packageName.fileprovider", captureFile
            )
            val cameraIntent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, cameraImageUri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
            if (cameraIntent.resolveActivity(packageManager) != null) {
                cameraIntents.add(cameraIntent)
            }

            val chooser = Intent(Intent.ACTION_CHOOSER).apply {
                putExtra(Intent.EXTRA_INTENT, galleryIntent)
                putExtra(Intent.EXTRA_TITLE, getString(R.string.file_chooser_title))
                if (cameraIntents.isNotEmpty()) {
                    putExtra(Intent.EXTRA_INITIAL_INTENTS, cameraIntents.toTypedArray())
                }
            }
            fileChooserLauncher.launch(chooser)
            true
        } catch (e: Exception) {
            filePathCallback?.onReceiveValue(null)
            filePathCallback = null
            cameraImageUri = null
            false
        }
    }

    private fun deliverFileChooserResult(result: ActivityResult) {
        val callback = filePathCallback ?: return
        var uris: Array<Uri>? = null

        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            val clip = data?.clipData
            uris = when {
                clip != null -> Array(clip.itemCount) { clip.getItemAt(it).uri }
                data?.data != null -> arrayOf(data.data!!)
                cameraImageUri != null -> arrayOf(cameraImageUri!!) // camera writes to EXTRA_OUTPUT
                else -> null
            }
        }

        callback.onReceiveValue(uris)
        filePathCallback = null
        cameraImageUri = null
    }

    /** Exposed to the page as window.AndroidPrint — drives the report download. */
    inner class PrintBridge {
        @JavascriptInterface
        fun printPage() {
            runOnUiThread {
                val printManager = getSystemService(PRINT_SERVICE) as PrintManager
                val jobName = getString(R.string.app_name) + " Report"
                val adapter = webView.createPrintDocumentAdapter(jobName)
                printManager.print(jobName, adapter, PrintAttributes.Builder().build())
            }
        }
    }

    companion object {
        private const val START_URL =
            "https://appassets.androidplatform.net/index.html"

        // Public https base where /assets/... are reachable. The server renders
        // the INDRIYA PDF by fetching the sample images, so this MUST resolve on
        // the open internet (the in-app appassets origin is device-local).
        // Set this to wherever the web build's assets are hosted.
        private const val HOSTED_ASSET_BASE =
            "https://muluxlabs.github.io/fire-assessment-unirp/"
    }
}
