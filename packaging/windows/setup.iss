; Build the portable payload at release\Kasaneri-Windows-installer before running ISCC.
#define AppName "Kasaneri"
#ifndef AppVersion
#define AppVersion "1.0.0"
#endif
#define Src "..\..\release\Kasaneri-Windows-installer"
#define OutDir "..\..\release\installer"

[Setup]
AppId={{3C6B7E2A-9F4D-4C1B-8E55-7A0D2B6C4E19}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Kasaneri
DefaultDirName={autopf}\Kasaneri
DisableProgramGroupPage=yes
DisableWelcomePage=no
OutputDir={#OutDir}
OutputBaseFilename=Kasaneri-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\Kasaneri.exe
LicenseFile=..\..\LICENSE
ShowLanguageDialog=yes
LanguageDetectionMethod=none
UsePreviousLanguage=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
chinesesimplified.WelcomeLabel2=向导会安装 [name/ver]。%n%n首次启动时，你可以新建资料库或选择已有资料库。
english.WelcomeLabel2=This wizard installs [name/ver].%n%nWhen you first open Kasaneri, you can create a library or choose an existing one.
chinesesimplified.ConfirmUninstall=确定要卸载 %1 吗？%n%n默认保留资料库。
english.ConfirmUninstall=Uninstall %1?%n%nYour library is kept by default.

[CustomMessages]
chinesesimplified.RemoveLibrary=同时删除程序目录下的资料库吗？%n%n%1%n%n此操作会永久删除其中的卡片、附件、备份和垃圾桶。选择「否」可保留资料库。
english.RemoveLibrary=Also delete the library in the application folder?%n%n%1%n%nThis permanently deletes its cards, attachments, backups, and trash. Choose No to keep the library.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#Src}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\Kasaneri.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\Kasaneri.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Kasaneri.exe"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\state"
Type: files; Name: "{app}\install-language.txt"
Type: files; Name: "{app}\debug.log"
Type: dirifempty; Name: "{app}"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  LanguageFile, Locale: String;
begin
  if CurStep = ssPostInstall then
  begin
    LanguageFile := ExpandConstant('{app}\install-language.txt');
    if not FileExists(LanguageFile) then
    begin
      Locale := 'zh-CN';
      if ActiveLanguage = 'english' then
        Locale := 'en';
      if not SaveStringToFile(LanguageFile, Locale, False) then
        Log('Could not write the initial application language.');
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{app}\data');
    if DirExists(DataDir) and (not UninstallSilent) then
      if MsgBox(FmtMessage(CustomMessage('RemoveLibrary'), [DataDir]), mbConfirmation,
                MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
  end;
end;
