import java.io.File
import java.util.Properties
import javax.inject.Inject

plugins {
    id("com.android.application")
}

val repoRoot = rootProject.projectDir.parentFile
val packageVersion = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
    .find(File(repoRoot, "package.json").readText())!!.groupValues[1]

// Фронтенд (public/) и модули server/, которые работают в WebView (подпись, парсеры), собирает
// android/tools/sync-web.mjs в build/ — в репозиторий копия не попадает
abstract class SyncWeb @Inject constructor(private val exec: ExecOperations) : DefaultTask() {
    @get:Internal abstract val repo: DirectoryProperty
    @get:InputFiles @get:PathSensitive(PathSensitivity.RELATIVE) abstract val sources: ConfigurableFileCollection
    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    fun run() {
        exec.exec {
            workingDir = repo.get().asFile
            commandLine("node", "android/tools/sync-web.mjs", outputDir.get().asFile.resolve("www").absolutePath)
        }
    }
}

val syncWeb = tasks.register<SyncWeb>("syncWeb") {
    repo.set(repoRoot)
    sources.from(File(repoRoot, "public"), File(repoRoot, "server"), File(repoRoot, "package.json"),
        File(rootProject.projectDir, "web"), File(rootProject.projectDir, "tools"))
}

android {
    namespace = "com.arigandores.anix"
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }

    defaultConfig {
        applicationId = "com.arigandores.anix"
        minSdk = 30 // insetsController, WindowInsets.Type
        targetSdk = 37
        // 1.6.0 → 10600: каждая следующая версия ставится поверх прежней
        versionCode = packageVersion.split('.').map { it.takeWhile(Char::isDigit).toInt() }.let { (a, b, c) -> a * 10000 + b * 100 + c }
        versionName = packageVersion
    }

    // Ключ подписи релиза: переменные ANIX_KEYSTORE (путь), ANIX_KEYSTORE_PASSWORD, ANIX_KEY_ALIAS, ANIX_KEY_PASSWORD (CI)
    // или android/keystore.properties (storeFile, storePassword, keyAlias, keyPassword; в репозиторий не попадает).
    // Обновление ставится поверх, только если ключ тот же, — ключ не терять
    val keyProps = Properties().apply {
        val f = rootProject.file("keystore.properties")
        if (f.exists()) f.inputStream().use { load(it) }
    }
    fun key(env: String, prop: String): String? = System.getenv(env)?.takeIf { it.isNotEmpty() } ?: keyProps.getProperty(prop)
    val storePath = key("ANIX_KEYSTORE", "storeFile")
    signingConfigs {
        if (storePath != null) create("release") {
            storeFile = rootProject.file(storePath)
            storePassword = key("ANIX_KEYSTORE_PASSWORD", "storePassword")
            keyAlias = key("ANIX_KEY_ALIAS", "keyAlias")
            keyPassword = key("ANIX_KEY_PASSWORD", "keyPassword")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (storePath != null) signingConfigs.getByName("release") else {
                logger.warn("android: нет ключа подписи (keystore.properties или ANIX_KEYSTORE) — релиз подписан отладочным ключом")
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(syncWeb, SyncWeb::outputDir)
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:5.5.0")
}
