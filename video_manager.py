import os
import random
import json
import requests
from bs4 import BeautifulSoup
from urllib.parse import urlparse, parse_qs
import time
from tiktok_uploader.Config import Config
from tiktok_uploader.basics import eprint

class VideoManager:
    def __init__(self):
        self.config = Config.get()
        self.videos_dir = os.path.join(os.getcwd(), self.config.videos_dir)
        self.uploaded_log_file = os.path.join(os.getcwd(), "uploaded_video_ids.json")
        self.yt_sources_file = os.path.join(os.getcwd(), "YT sources.txt")
        
        # Ensure directories exist
        os.makedirs(self.videos_dir, exist_ok=True)
        
        # Load uploaded video IDs log
        self.uploaded_video_ids = self._load_uploaded_ids()
    
    def _load_uploaded_ids(self):
        """Load the list of already uploaded video IDs"""
        if os.path.exists(self.uploaded_log_file):
            try:
                with open(self.uploaded_log_file, 'r') as f:
                    return set(json.load(f))
            except (json.JSONDecodeError, FileNotFoundError):
                return set()
        return set()
    
    def _save_uploaded_ids(self):
        """Save the list of uploaded video IDs"""
        with open(self.uploaded_log_file, 'w') as f:
            json.dump(list(self.uploaded_video_ids), f, indent=2)
    
    def _log_uploaded_video_id(self, video_id):
        """Add a video ID to the uploaded log"""
        self.uploaded_video_ids.add(video_id)
        self._save_uploaded_ids()
        print(f"[+] Logged uploaded video ID: {video_id}")
    
    def find_local_mp4(self):
        """Find the first MP4 file in the videos directory"""
        try:
            for filename in os.listdir(self.videos_dir):
                if filename.lower().endswith('.mp4'):
                    file_path = os.path.join(self.videos_dir, filename)
                    if os.path.isfile(file_path):
                        return filename
        except FileNotFoundError:
            pass
        return None
    
    def delete_local_mp4(self, filename):
        """Delete a local MP4 file after successful upload"""
        try:
            file_path = os.path.join(self.videos_dir, filename)
            os.remove(file_path)
            print(f"[+] Deleted local file: {filename}")
            return True
        except Exception as e:
            eprint(f"[-] Failed to delete file {filename}: {str(e)}")
            return False
    
    def get_random_yt_source(self):
        """Get a random YouTube source URL from YT sources.txt"""
        try:
            with open(self.yt_sources_file, 'r') as f:
                sources = [line.strip() for line in f if line.strip() and not line.startswith('#')]
            
            if not sources:
                eprint("[-] No YouTube sources found in YT sources.txt")
                return None
            
            return random.choice(sources)
        except FileNotFoundError:
            eprint("[-] YT sources.txt file not found")
            return None
    
    def extract_video_id_from_url(self, url):
        """Extract video ID from YouTube shorts URL"""
        try:
            if "/shorts/" in url:
                return url.split("/shorts/")[1].split("?")[0]
            elif "v=" in url:
                parsed_url = urlparse(url)
                return parse_qs(parsed_url.query)['v'][0]
            elif "youtu.be/" in url:
                return url.split("youtu.be/")[1].split("?")[0]
        except Exception as e:
            eprint(f"[-] Failed to extract video ID from URL {url}: {str(e)}")
        return None
    
    def scrape_shorts_from_channel(self, channel_url):
        """Scrape shorts URLs from a YouTube channel's shorts page"""
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
            
            response = requests.get(channel_url, headers=headers, timeout=10)
            response.raise_for_status()
            
            # Look for shorts URLs in the page content
            shorts_urls = []
            content = response.text
            
            # Find all shorts URLs in the page
            import re
            shorts_pattern = r'"/shorts/([a-zA-Z0-9_-]{11})"'
            matches = re.findall(shorts_pattern, content)
            
            for video_id in matches:
                if video_id not in self.uploaded_video_ids:
                    shorts_urls.append(f"https://www.youtube.com/shorts/{video_id}")
            
            return shorts_urls
            
        except Exception as e:
            eprint(f"[-] Failed to scrape shorts from {channel_url}: {str(e)}")
            return []
    
    def get_random_unuploaded_short(self):
        """Get a random YouTube short that hasn't been uploaded yet"""
        max_attempts = 5
        
        for attempt in range(max_attempts):
            source_url = self.get_random_yt_source()
            if not source_url:
                continue
            
            print(f"[+] Attempting to get shorts from: {source_url}")
            shorts_urls = self.scrape_shorts_from_channel(source_url)
            
            if not shorts_urls:
                print(f"[-] No new shorts found from {source_url}, trying another source...")
                continue
            
            # Pick a random short from the available ones
            selected_url = random.choice(shorts_urls)
            video_id = self.extract_video_id_from_url(selected_url)
            
            if video_id and video_id not in self.uploaded_video_ids:
                print(f"[+] Selected YouTube short: {selected_url}")
                return selected_url, video_id
            
        eprint("[-] Could not find any new YouTube shorts to upload after multiple attempts")
        return None, None
    
    def get_next_video_for_upload(self):
        """
        Get the next video for upload following the priority:
        1. Local MP4 files first
        2. Random YouTube short if no local files
        
        Returns: (video_source, video_id, is_local)
        """
        # First, check for local MP4 files
        local_mp4 = self.find_local_mp4()
        if local_mp4:
            print(f"[+] Found local MP4 file: {local_mp4}")
            return local_mp4, None, True
        
        # If no local files, get a YouTube short
        print("[+] No local MP4 files found, getting YouTube short...")
        yt_url, video_id = self.get_random_unuploaded_short()
        if yt_url and video_id:
            return yt_url, video_id, False
        
        return None, None, False
    
    def mark_video_as_uploaded(self, video_source, video_id, is_local):
        """Mark a video as successfully uploaded and clean up if needed"""
        if is_local:
            # Delete the local file
            self.delete_local_mp4(video_source)
        else:
            # Log the YouTube video ID
            if video_id:
                self._log_uploaded_video_id(video_id)