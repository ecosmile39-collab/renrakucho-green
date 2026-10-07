param(
    [string]$WorkspaceRoot = (Get-Location).Path,
    [string]$FFmpegPath,
    [switch]$PreviewOnly
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Speech
$buildDirectory = Join-Path $env:TEMP "renrakucho-line-guide-build"
$assetsDirectory = Join-Path $WorkspaceRoot "assets"
New-Item -ItemType Directory -Force -Path $buildDirectory, $assetsDirectory | Out-Null
$scenes = @(
    @{ Title = "最初に用意するもの"; Screen = "2つの情報を、同じ施設のチャネルから取得"; Address = "実際の秘密情報は動画に表示しません"; Rows = @("1. チャネルアクセストークン：Messaging API設定から取得", "2. Channel secret：チャネル基本設定から取得", "施設のLINE公式アカウントを管理できるパソコンで操作"); Highlight = 0; Subtitle = "2つとも、同じ施設・同じMessaging APIチャネルの情報を使います。"; Narration = "施設のライン設定をご案内します。用意するのは、チャネルアクセストークンと、チャネルシークレットの二つです。二つとも、同じ施設の、同じメッセージングエーピーアイチャネルから取得します。パソコンで操作し、わからないところでは動画を一時停止してください。" },
    @{ Title = "施設のLINE管理画面を開く"; Screen = "LINE Official Account Manager"; Address = "https://manager.line.biz/"; Rows = @("施設の管理者アカウントでログイン", "施設の公式アカウント名を選択", "個人のLINEではなく、施設の公式アカウントを確認"); Highlight = 1; Subtitle = "manager.line.biz を開き、設定したい施設のアカウントを選びます。"; Narration = "まず、画面に表示している、ライン公式アカウントの管理画面を開きます。施設の管理者アカウントでログインし、施設の公式アカウント名を選んでください。管理者権限がない場合は、施設の担当者に相談してください。" },
    @{ Title = "Messaging APIを有効にする"; Screen = "LINE公式アカウントの設定"; Address = "LINE Official Account Manager / 設定"; Rows = @("設定", "Messaging API", "Messaging APIを利用する", "すでに有効なら、新しく作らず次へ"); Highlight = 2; Subtitle = "「設定」→「Messaging API」→「Messaging APIを利用する」の順に進みます。"; Narration = "管理画面の、設定を開き、メッセージングエーピーアイを選びます。まだ利用していなければ、利用するボタンを押します。すでに有効になっている場合は、新しく作る必要はありません。次の説明へ進んでください。" },
    @{ Title = "初回だけ：開発者情報とプロバイダー"; Screen = "Messaging APIの利用開始"; Address = "不明な場合は、施設の管理者に確認"; Rows = @("初回は開発者の名前・メールアドレスを登録", "プロバイダー：施設・法人がチャネルを管理する単位", "既存の施設・法人の管理方針を確認して選択", "一度選んだプロバイダーは後から変更できません"); Highlight = 3; Subtitle = "プロバイダーは後から変更できません。迷ったら、選ぶ前に管理者へ確認します。"; Narration = "初めて利用するときは、開発者の名前やメールアドレスの登録を求められる場合があります。次に、プロバイダーという管理単位を選びます。施設や法人の管理方針に合わせてください。一度選ぶと後から変更できないため、わからない場合は、選ぶ前に管理者へ確認してください。" },
    @{ Title = "LINE Developersで施設のチャネルを開く"; Screen = "LINE Developersコンソール"; Address = "https://developers.line.biz/console/"; Rows = @("公式アカウント管理画面と同じアカウントでログイン", "施設・法人のプロバイダーをクリック", "施設名のMessaging APIチャネルをクリック", "LINE Loginチャネルではありません"); Highlight = 2; Subtitle = "施設・法人のプロバイダー → 施設名の「Messaging API」チャネルを開きます。"; Narration = "続いて、ライン デベロッパーズのコンソールを開きます。先ほどと同じアカウントでログインし、施設や法人のプロバイダーを選びます。その中にある、施設名のメッセージングエーピーアイチャネルを開いてください。ラインログイン用のチャネルとは別です。" },
    @{ Title = "1. アクセストークンの場所"; Screen = "施設のMessaging APIチャネル"; Address = "Messaging API / Messaging API設定"; Rows = @("Basic settings / チャネル基本設定", "Messaging API / Messaging API設定 を選択", "ページを下へスクロール", "Channel access token (long-lived) / チャネルアクセストークン（長期）"); Highlight = 3; Subtitle = "「Messaging API設定」を開き、下の方の「チャネルアクセストークン（長期）」を探します。"; Narration = "一つ目のアクセストークンを取得します。メッセージングエーピーアイ設定のタブを開き、ページを下へスクロールします。チャネルアクセストークン、長期、と書かれている欄を探してください。英語表示では、画面に示した項目名です。" },
    @{ Title = "発行して、値全体をコピー"; Screen = "チャネルアクセストークン（長期）"; Address = "Messaging API設定の下部"; Rows = @("Issue / 発行 を押す（まだ発行されていない場合）", "表示された長い文字列を、途中で切らずに全体コピー", "********************  実際の値は非表示", "既存トークンがある場合は、不用意に再発行しない"); Highlight = 1; Subtitle = "未発行なら「発行」。表示された長い文字列をすべてコピーします。"; Narration = "まだ発行されていなければ、発行、またはイシューと書かれたボタンを押します。表示された長い文字列を、全体コピーしてください。すでにトークンがある場合は、まずその値を使います。他のシステムも利用している場合、再発行すると影響することがあるため、不用意に再発行しないでください。" },
    @{ Title = "アプリの1つ目の欄へ貼り付ける"; Screen = "連絡帳アプリ / 施設のLINE公式アカウント"; Address = "連絡帳アプリ → 設定を開く"; Rows = @("チャネルアクセストークン", "********************  ここへ貼り付け", "Channel secret（32文字）", "こちらは、まだ空欄で大丈夫です"); Highlight = 1; Subtitle = "アプリの「設定を開く」を押し、1つ目のアクセストークン欄へ貼り付けます。"; Narration = "連絡帳アプリに戻ります。施設のライン公式アカウントの、設定を開くを押してください。一つ目の、チャネルアクセストークン欄へ、コピーした文字列を貼り付けます。黒い点や星で隠れて表示されても正常です。まだ保存せず、二つ目を取得します。" },
    @{ Title = "2. Channel secretの場所"; Screen = "同じ施設のMessaging APIチャネル"; Address = "Basic settings / チャネル基本設定"; Rows = @("Basic settings / チャネル基本設定 を選択", "ページを下へスクロール", "Channel secret / チャネルシークレット", "********************************  実際の値は非表示"); Highlight = 2; Subtitle = "同じチャネルの「チャネル基本設定」から、Channel secretの32文字をコピーします。"; Narration = "ライン デベロッパーズに戻り、同じ施設のチャネルで、ベーシック セッティングス、チャネル基本設定を開きます。下へスクロールして、チャネルシークレットを探します。この三十二文字をすべてコピーしてください。チャネルアイディーと間違えないようにします。再発行は押す必要がありません。" },
    @{ Title = "アプリの2つ目の欄へ貼り付ける"; Screen = "連絡帳アプリ / LINE設定"; Address = "1つ目と2つ目を、逆にしないでください"; Rows = @("チャネルアクセストークン：長い文字列", "********************", "Channel secret（32文字）：基本設定からコピーした値", "********************************  ここへ貼り付け"); Highlight = 3; Subtitle = "32文字のChannel secretは、アプリの2つ目の欄に貼り付けます。"; Narration = "もう一度、連絡帳アプリへ戻ります。二つ目の、チャネルシークレット、三十二文字の欄に貼り付けます。一つ目は長いアクセストークン、二つ目は三十二文字のシークレットです。二つとも、同じ施設のチャネルからコピーしたか確認しましょう。" },
    @{ Title = "「LINE設定を保存」を押す"; Screen = "連絡帳アプリ / LINE設定"; Address = "秘密情報は保存後に再表示されません"; Rows = @("チャネルアクセストークン：入力済み", "Channel secret（32文字）：入力済み", "LINE設定を保存", "保存成功後、施設専用のWebhook URLが表示されます"); Highlight = 2; Subtitle = "2つの欄を確認して保存します。保存後もWebhook設定が必要です。"; Narration = "二つの欄に入力できたら、ライン設定を保存を押します。成功すると、施設名と、施設専用のウェブフックユーアールエルが表示されます。秘密情報は、保存後に再表示されません。ここで終わりではなく、次の接続設定も行ってください。" },
    @{ Title = "Webhook URLを登録・検証する"; Screen = "LINE Developers / Messaging API設定"; Address = "他社のWebhook URLがある場合は上書きせず相談"; Rows = @("アプリで「Webhook URLをコピー」を押す", "Webhook URL → 編集 / Edit → 貼り付け → 更新 / Update", "検証 / Verify → 成功 / Success を確認", "Webhookの利用 / Use webhook → オン"); Highlight = 3; Subtitle = "アプリのURLを登録し、検証で成功を確認してから「Webhookの利用」をオンにします。"; Narration = "アプリの、ウェブフックユーアールエルをコピーを押します。ライン デベロッパーズのメッセージングエーピーアイ設定に戻り、ウェブフックのユーアールエルを編集して貼り付け、更新します。検証で成功を確認し、ウェブフックの利用をオンにします。すでに他社のユーアールエルがある場合は、上書きせず担当者へ相談してください。" },
    @{ Title = "家族との連携を確認する"; Screen = "連絡帳アプリと家族のLINE"; Address = "自動通知ではなく、家族の操作に返信します"; Rows = @("施設：対象利用者のLINE連携コードを発行", "家族：施設の公式LINEへコードを送信（24時間以内）", "施設：連絡帳を保存して、家族向けに公開", "家族：「連絡帳を見る」と送信 → 返信のリンクを開く"); Highlight = 3; Subtitle = "家族が「連絡帳を見る」と送信し、返信のリンクを開けたら確認完了です。"; Narration = "最後に、家族との連携を確認します。施設が対象利用者の連携コードを発行し、家族が二十四時間以内に、施設の公式ラインへ送ります。連絡帳を保存して家族向けに公開したあと、家族が、連絡帳を見る、と送信します。返信のリンクが開けたら確認完了です。施設からの自動通知はありません。" },
    @{ Title = "秘密情報は共有しない"; Screen = "設定に困ったときの確認事項"; Address = "LINEの画面名や配置は変更されることがあります"; Rows = @("トークン・シークレットはメールやチャットに送らない", "画面写真を送るときも、秘密情報を必ず隠す", "同じ施設のチャネルか、欄を逆にしていないか確認", "既存の他社設定・プロバイダーが不明なら管理者へ相談"); Highlight = 0; Subtitle = "トークンとシークレットは大切な鍵です。第三者に送らず、施設で管理してください。"; Narration = "アクセストークンとシークレットは、施設の公式ラインを動かす大切な鍵です。メールやチャットで第三者に送らないでください。画面写真を送る場合も、必ず隠します。画面の名前や配置が変わったときは、動画の項目名を目印にしてください。不明な点は、秘密情報を伝えずに担当者へ相談しましょう。" }
)

$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
$japaneseVoice = $speech.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq "ja-JP" } | Select-Object -First 1
if (!$japaneseVoice) { throw "A Japanese Windows speech voice is required." }
$speech.SelectVoice($japaneseVoice.VoiceInfo.Name)
$speech.Rate = -1
$titleFont = New-Object System.Drawing.Font("Yu Gothic", 30, ([System.Drawing.FontStyle]::Bold))
$bodyFont = New-Object System.Drawing.Font("Yu Gothic", 22)
$smallFont = New-Object System.Drawing.Font("Yu Gothic", 16)
$subtitleFont = New-Object System.Drawing.Font("Yu Gothic", 25, ([System.Drawing.FontStyle]::Bold))
$borderPen = New-Object System.Drawing.Pen(([System.Drawing.ColorTranslator]::FromHtml("#d6dde0")), 2)
$highlightPen = New-Object System.Drawing.Pen(([System.Drawing.ColorTranslator]::FromHtml("#d06a13")), 4)
$format = New-Object System.Drawing.StringFormat
$format.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
$chapters = @()
$totalSeconds = 0.0
$subtitleLines = @("WEBVTT", "")

function Format-VideoTime([double]$seconds) {
    return [TimeSpan]::FromSeconds($seconds).ToString("hh\:mm\:ss\.fff")
}

try {
    for ($sceneIndex = 0; $sceneIndex -lt $scenes.Count; $sceneIndex++) {
        $scene = $scenes[$sceneIndex]
        $stem = Join-Path $buildDirectory ("scene-{0:D2}" -f $sceneIndex)
        $bitmap = New-Object System.Drawing.Bitmap(1280, 720)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml("#eef3f5"))
        $graphics.FillRectangle([System.Drawing.Brushes]::White, 40, 135, 1200, 385)
        $graphics.DrawString(("{0:D2} / {1:D2}  {2}" -f ($sceneIndex + 1), $scenes.Count, $scene.Title), $titleFont, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF(48, 32, 1180, 72)), $format)
        $graphics.DrawString($scene.Screen, $bodyFont, [System.Drawing.Brushes]::DarkGreen, 68, 148)
        $graphics.DrawString($scene.Address, $smallFont, [System.Drawing.Brushes]::DimGray, (New-Object System.Drawing.RectangleF(68, 188, 1140, 35)), $format)
        for ($rowIndex = 0; $rowIndex -lt $scene.Rows.Count; $rowIndex++) {
            $rowY = 230 + $rowIndex * 65
            $graphics.DrawRectangle($borderPen, 68, $rowY, 1140, 57)
            if ($rowIndex -eq $scene.Highlight) {
                $graphics.FillRectangle([System.Drawing.Brushes]::LemonChiffon, 69, ($rowY + 1), 1138, 55)
                $graphics.DrawRectangle($highlightPen, 68, $rowY, 1140, 57)
            }
            $graphics.DrawString($scene.Rows[$rowIndex], $bodyFont, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF(82, ($rowY + 8), 1110, 46)), $format)
        }
        $graphics.FillRectangle([System.Drawing.Brushes]::White, 40, 540, 1200, 130)
        $graphics.DrawString($scene.Subtitle, $subtitleFont, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF(62, 550, 1150, 110)), $format)
        $graphics.DrawString("説明用の再現画面 / 実際の秘密情報は使用していません / 2026-10-07", $smallFont, [System.Drawing.Brushes]::DimGray, 48, 680)
        $bitmap.Save("$stem.png", [System.Drawing.Imaging.ImageFormat]::Png)
        if ($sceneIndex -eq 0) { $bitmap.Save((Join-Path $assetsDirectory "line-setup-guide.jpg"), [System.Drawing.Imaging.ImageFormat]::Jpeg) }
        $graphics.Dispose()
        $bitmap.Dispose()
        $speech.SetOutputToWaveFile("$stem.wav")
        $speech.Speak($scene.Narration)
        $speech.SetOutputToNull()
        $chapters += @{ title = $scene.Title; start = $totalSeconds; narration = $scene.Narration; subtitle = $scene.Subtitle }
        if (!$PreviewOnly) {
            if (!(Test-Path $FFmpegPath)) { throw "Provide the FFmpeg executable path." }
            $encodeProgress = & $FFmpegPath -hide_banner -loglevel error -progress pipe:1 -nostats -y -loop 1 -framerate 10 -i "$stem.png" -i "$stem.wav" -vf "fade=t=in:st=0:d=0.3,format=yuv420p" -af "apad=pad_dur=1" -c:v libx264 -preset veryfast -tune stillimage -crf 24 -c:a aac -b:a 96k -shortest "$stem.mp4"
            if ($LASTEXITCODE -ne 0) { throw "FFmpeg failed to encode scene $sceneIndex." }
            $lastTime = $encodeProgress | Where-Object { $_ -like "out_time_us=*" } | Select-Object -Last 1
            if (!$lastTime) { throw "Encoded video duration was not found." }
            $duration = [double]($lastTime.Split("=")[1]) / 1000000
            $subtitleLines += "$(Format-VideoTime $totalSeconds) --> $(Format-VideoTime ($totalSeconds + $duration))"
            $subtitleLines += $scene.Subtitle
            $subtitleLines += ""
            $totalSeconds += $duration
        }
        Write-Output ("Created scene {0}: {1}" -f ($sceneIndex + 1), $scene.Title)
        if ($PreviewOnly) { break }
    }
    if (!$PreviewOnly) {
        $concatPath = Join-Path $buildDirectory "scenes.txt"
        $concatLines = 0..($scenes.Count - 1) | ForEach-Object { "file 'scene-{0:D2}.mp4'" -f $_ }
        [System.IO.File]::WriteAllLines($concatPath, $concatLines, (New-Object System.Text.UTF8Encoding($false)))
        & $FFmpegPath -hide_banner -loglevel error -y -f concat -safe 0 -i $concatPath -c copy -movflags +faststart (Join-Path $assetsDirectory "line-setup-guide.mp4")
        if ($LASTEXITCODE -ne 0) { throw "FFmpeg failed to combine scenes." }
        [System.IO.File]::WriteAllLines((Join-Path $assetsDirectory "line-setup-guide.vtt"), $subtitleLines, (New-Object System.Text.UTF8Encoding($false)))
        $metadata = @{ title = "施設LINE設定ガイド"; generatedAt = "2026-10-07"; duration = $totalSeconds; chapters = $chapters }
        [System.IO.File]::WriteAllText((Join-Path $assetsDirectory "line-setup-guide.json"), ($metadata | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
        Write-Output ("Video duration: {0:N1} seconds" -f $totalSeconds)
    }
} finally {
    $speech.Dispose()
    $titleFont.Dispose()
    $bodyFont.Dispose()
    $smallFont.Dispose()
    $subtitleFont.Dispose()
    $borderPen.Dispose()
    $highlightPen.Dispose()
    $format.Dispose()
}