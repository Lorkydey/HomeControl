use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AppConfig {
    pub version: u8,
    pub window: PanelConfig,
    pub lights: Vec<LightConfig>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PanelConfig {
    pub width: u32,
    pub margin: u32,
    pub hide_on_blur: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LightConfig {
    pub id: String,
    pub name: String,
    pub icon: LightIcon,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<LightSource>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum LightSource {
    Matter,
    Logitech,
    Aura,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LightIcon {
    Bulb,
    Bed,
    Sofa,
    Kitchen,
    Desk,
    Sun,
    Keyboard,
    Pc,
}
pub struct Settings {
    pub config: AppConfig,
    pub path: PathBuf,
}

fn valid_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.trim().chars().count() <= 40
        && !name.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}
pub fn parse(source: &str) -> Result<AppConfig, String> {
    let mut config: AppConfig =
        serde_json::from_str(source.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())?;
    if config.version != 1 {
        return Err("Version de configuration inconnue.".into());
    }
    if !(280..=480).contains(&config.window.width) || config.window.margin > 32 {
        return Err(
            "window.width doit être entre 280 et 480 ; window.margin entre 0 et 32.".into(),
        );
    }
    if !(1..=8).contains(&config.lights.len()) {
        return Err("Configurez entre une et huit lampes.".into());
    }
    let mut ids = std::collections::HashSet::new();
    let mut local_sources = std::collections::HashSet::new();
    for light in &mut config.lights {
        if let Some(source @ (LightSource::Logitech | LightSource::Aura)) = &light.source {
            if !local_sources.insert(source.clone()) {
                return Err("Chaque source RGB locale ne peut apparaître qu’une fois.".into());
            }
        }
        if light.id.is_empty()
            || light.id.len() > 32
            || !light.id.starts_with(|c: char| c.is_ascii_lowercase())
            || !light
                .id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            || !ids.insert(light.id.clone())
        {
            return Err("Les id doivent être uniques, composés de lettres minuscules, chiffres ou tirets (1 à 32 caractères).".into());
        }
        if !valid_name(&light.name) {
            return Err(
                "Chaque nom doit contenir 1 à 40 caractères, sans caractères de contrôle.".into(),
            );
        }
        light.name = light.name.trim().to_owned();
    }
    Ok(config)
}
pub fn load(directory: &Path) -> Result<Settings, String> {
    use std::io::Write;
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let path = directory.join("config.json");
    if !path.exists() {
        let mut config = parse(include_str!("../../config.example.json"))?;
        // Legacy names are imported once; no fabric data is copied into config.json.
        if let Ok(source) = std::fs::read_to_string(directory.join("lights.json")) {
            if let Ok(serde_json::Value::Array(slots)) = serde_json::from_str(&source) {
                for (index, light) in config.lights.iter_mut().enumerate() {
                    let previous = slots
                        .iter()
                        .find(|slot| slot["id"].as_str() == Some(&light.id))
                        .or_else(|| slots.get(index).filter(|slot| slot["id"].is_null()));
                    let Some(previous) = previous else {
                        continue;
                    };
                    if let Some(name) = previous["name"].as_str().filter(|name| valid_name(name)) {
                        light.name = name.trim().to_owned();
                    }
                }
            }
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        let serialized = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        file.write_all(format!("{serialized}\n").as_bytes())
            .map_err(|e| e.to_string())?;
    }
    let source = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let config = parse(&source)?;
    let schema = directory.join("config.schema.json");
    if !schema.exists() {
        std::fs::write(schema, include_str!("../../config.schema.json"))
            .map_err(|e| e.to_string())?;
    }
    Ok(Settings { config, path })
}
pub fn show_error(message: &str) {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        unsafe extern "system" {
            fn MessageBoxW(window: isize, text: *const u16, title: *const u16, kind: u32) -> i32;
        }
        let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "Home Control".encode_utf16().chain(Some(0)).collect();
        unsafe {
            MessageBoxW(0, text.as_ptr(), title.as_ptr(), 0x10);
        }
    }
    #[cfg(not(windows))]
    eprintln!("{message}");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn example_is_valid_and_unknown_options_and_duplicate_ids_are_rejected() {
        let source = include_str!("../../config.example.json");
        assert_eq!(parse(source).unwrap().lights.len(), 3);
        assert!(parse(&source.replace("320", "100")).is_err());
        assert!(parse(&source.replace("light-2", "light-1")).is_err());
        assert!(parse(&source.replace("hideOnBlur", "hideOnBlurr")).is_err());
        assert!(parse(&source.replace("bed", "unknown")).is_err());
        assert!(parse(&format!("\u{feff}{source}")).is_ok());
    }
    #[test]
    fn local_rgb_sources_are_validated_and_preserved() {
        let mut value: serde_json::Value =
            serde_json::from_str(include_str!("../../config.example.json")).unwrap();
        value["lights"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "keyboard", "name": "Clavier", "icon": "keyboard", "source": "logitech"
            }));
        value["lights"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "pc", "name": "PC", "icon": "pc", "source": "aura"
            }));
        let parsed = parse(&value.to_string()).unwrap();
        assert_eq!(parsed.lights[3].source, Some(LightSource::Logitech));
        assert_eq!(parsed.lights[4].source, Some(LightSource::Aura));
        value["lights"][3]["source"] = serde_json::json!("aura");
        assert!(parse(&value.to_string()).is_err());
        value["lights"][3]["source"] = serde_json::json!("unknown");
        assert!(parse(&value.to_string()).is_err());
    }
}
