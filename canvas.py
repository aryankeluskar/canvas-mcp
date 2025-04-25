import asyncio
from dotenv import load_dotenv
import os
import json
import requests
import base64
import google.generativeai as genai
import mimetypes
import time
from typing import Any, Optional, Dict, List
from mcp.server.fastmcp import FastMCP
from gradescopeapi.classes.connection import GSConnection
# Import gradescope functions from gradescope.py
import gradescope
from datetime import datetime

import sys

# Initialize FastMCP server
mcp = FastMCP("canvas_and_gradescope")

# Print Gemini API version for debugging
try:
    genai_version = getattr(genai, "__version__", "unknown")
    print(f"Using google.generativeai version: {genai_version}")
except Exception as e:
    print(f"Could not determine google.generativeai version: {e}")

load_dotenv()

# Simple in-memory cache
cache = {
    "courses": None,
    "modules": {},
    "module_items": {},
    "file_urls": {},
    "course_analysis": {},
    "module_analysis": {},
    "resource_analysis": {},
    "assignments": {}  # Add assignments cache
}

# Cache expiration times (in seconds)
CACHE_TTL = {
    "courses": 3600,  # 1 hour
    "modules": 1800,  # 30 minutes
    "module_items": 1800,  # 30 minutes
    "file_urls": 3600,  # 1 hour
    "course_analysis": 7200,  # 2 hours
    "module_analysis": 7200,  # 2 hours
    "resource_analysis": 7200,  # 2 hours
    "assignments": 1800  # 30 minutes
}

cache_timestamps = {
    "courses": 0,
    "modules": {},
    "module_items": {},
    "file_urls": {},
    "course_analysis": {},
    "module_analysis": {},
    "resource_analysis": {},
    "assignments": {}  # Add assignments timestamps
}

def cache_get(cache_type, key=None):
    """Get an item from cache if it exists and is not expired"""
    current_time = time.time()
    
    if key is None:
        # For single-item caches like courses
        if cache_type in cache and cache[cache_type] is not None:
            if current_time - cache_timestamps[cache_type] < CACHE_TTL[cache_type]:
                return cache[cache_type]
    else:
        # For multi-item caches
        if cache_type in cache and key in cache[cache_type]:
            if key in cache_timestamps[cache_type] and current_time - cache_timestamps[cache_type][key] < CACHE_TTL[cache_type]:
                return cache[cache_type][key]
    
    return None

def cache_set(cache_type, value, key=None):
    """Store an item in cache with current timestamp"""
    current_time = time.time()
    
    if key is None:
        # For single-item caches
        cache[cache_type] = value
        cache_timestamps[cache_type] = current_time
    else:
        # For multi-item caches
        if cache_type not in cache:
            cache[cache_type] = {}
        if cache_type not in cache_timestamps:
            cache_timestamps[cache_type] = {}
            
        cache[cache_type][key] = value
        cache_timestamps[cache_type][key] = current_time

@mcp.tool()
async def get_courses():
    """Use this tool to retrieve all available Canvas courses for the current user. This tool returns a dictionary mapping course names to their corresponding IDs. Use this when you need to find course IDs based on names, display all available courses, or when needing to access any course-related information."""
    # Check cache first
    cached_courses = cache_get("courses")
    if cached_courses:
        print("Using cached courses data")
        return cached_courses

    try:
        url = "https://canvas.asu.edu/api/v1/courses?page=1&per_page=100"
        
        # Check if API key is available
        api_key = os.getenv('CANVAS_API_KEY')
        if not api_key:
            print("Error: CANVAS_API_KEY environment variable not set")
            return None
            
        headers = {
            "Authorization": f"Bearer {api_key}"
        }
        
        # Add timeout to prevent hanging
        response = requests.get(url, headers=headers, timeout=10)
        
        # Check response status
        if response.status_code != 200:
            print(f"Error: Canvas API returned status code {response.status_code}")
            print(f"Response: {response.text}")
            return None
            
        courses = response.json()

        out = {}

        for course in courses:
            if "id" in course and "name" in course:
                out.update({
                    course["name"]: course["id"]
                })

        # Only write to file if we have data and the filesystem is writable
        if out:
            try:
                is_writable = os.access(os.getcwd(), os.W_OK)
                if is_writable:
                    with open("courses.json", "w") as f:
                        json.dump(out, f)
                    print("Saved courses data to courses.json")
            except Exception as e:
                print(f"Warning: Could not save courses to file: {e}")
                
            # Store in cache
            cache_set("courses", out)
        else:
            print("Warning: No courses found in Canvas API response")
            return None

        return out

    except Exception as e:
        import traceback, sys
        print(f"Unexpected error in get_courses: {e}")
        print(f"Line number: {sys.exc_info()[-1].tb_lineno}")
        print(traceback.format_exc())
        return None

@mcp.tool()
async def get_modules(course_id):
    """Use this tool to retrieve all modules within a specific Canvas course. This tool returns a list of module objects containing module details like ID, name, and status. Use this when exploring or navigating course content structure."""
    # Check cache first
    cached_modules = cache_get("modules", course_id)
    if cached_modules:
        print(f"Using cached modules data for course {course_id}")
        return cached_modules

    try:
        url = f"https://canvas.asu.edu/api/v1/courses/{course_id}/modules"
        
        # Check if API key is available
        api_key = os.getenv('CANVAS_API_KEY')
        if not api_key:
            print("Error: CANVAS_API_KEY environment variable not set")
            return None
            
        headers = {
            "Authorization": f"Bearer {api_key}"
        }
        
        # Add timeout
        response = requests.get(url, headers=headers, timeout=10)
        
        # Check response status
        if response.status_code != 200:
            print(f"Error: Canvas API returned status code {response.status_code}")
            print(f"Response: {response.text}")
            return None

        modules = response.json()
        
        # Only write to file if we have data and the filesystem is writable
        if modules:
            try:
                is_writable = os.access(os.getcwd(), os.W_OK)
                if is_writable:
                    with open("modules.json", "w") as f:
                        json.dump(modules, f)
                    print(f"Saved modules data for course {course_id} to modules.json")
            except Exception as e:
                print(f"Warning: Could not save modules to file: {e}")
                
            # Store in cache
            cache_set("modules", modules, course_id)
        else:
            print(f"Warning: No modules found for course {course_id}")
            return None

        return modules
        
    except Exception as e:
        import traceback, sys
        print(f"Unexpected error in get_modules: {e}")
        print(f"Line number: {sys.exc_info()[-1].tb_lineno}")
        print(traceback.format_exc())
        return None

@mcp.tool()
async def get_module_items(course_id, module_id):
    """Use this tool to retrieve all items within a specific module in a Canvas course. This tool returns a list of module item objects containing details like title, type, and URLs. Use this when you need to access specific learning materials, assignments, or other content within a module."""
    # Check cache first
    cache_key = f"{course_id}_{module_id}"
    cached_items = cache_get("module_items", cache_key)
    if cached_items:
        print(f"Using cached module items for module {module_id} in course {course_id}")
        return cached_items

    try:
        url = f"https://canvas.asu.edu/api/v1/courses/{course_id}/modules/{module_id}/items?per_page=100"
        
        # Check if API key is available
        api_key = os.getenv('CANVAS_API_KEY')
        if not api_key:
            print("Error: CANVAS_API_KEY environment variable not set")
            return None
            
        headers = {
            "Authorization": f"Bearer {api_key}"
        }
        
        # Add timeout
        response = requests.get(url, headers=headers, timeout=10)
        
        # Check response status
        if response.status_code != 200:
            print(f"Error: Canvas API returned status code {response.status_code} for module items")
            print(f"Response: {response.text}")
            return None
            
        items = response.json()
        
        if not items:
            print(f"Warning: No items found for module {module_id} in course {course_id}")
            return None
            
        # Store in cache
        cache_set("module_items", items, cache_key)
            
        return items
        
    except requests.RequestException as e:
        import traceback, sys
        print(f"Error connecting to Canvas API for module items: {e}")
        print(f"Line number: {sys.exc_info()[-1].tb_lineno}")
        print(traceback.format_exc())
        return None
    except Exception as e:
        import traceback, sys
        print(f"Unexpected error in get_module_items: {e}")
        print(f"Line number: {sys.exc_info()[-1].tb_lineno}")
        print(traceback.format_exc())
        return None

@mcp.tool()
async def get_file_url(course_id, file_id):
    """Use this tool to get the direct download URL for a file stored in Canvas. This tool returns a URL string that can be used to access or download the file. Use this when you need direct access to file content rather than just the Canvas page URL."""
    # Check cache first
    cache_key = f"{course_id}_{file_id}"
    cached_url = cache_get("file_urls", cache_key)
    if cached_url:
        print(f"Using cached file URL for file {file_id} in course {course_id}")
        return cached_url

    try:
        url = f"https://canvas.asu.edu/api/v1/courses/{course_id}/files/{file_id}"
        
        # Check if API key is available
        api_key = os.getenv('CANVAS_API_KEY')
        if not api_key:
            print("Error: CANVAS_API_KEY environment variable not set")
            return None
            
        headers = {
            "Authorization": f"Bearer {api_key}"
        }
        
        # Add timeout
        response = requests.get(url, headers=headers, timeout=10)
        
        # Check response status
        if response.status_code != 200:
            print(f"Error: Canvas API returned status code {response.status_code} for file URL")
            print(f"Response: {response.text}")
            return None
            
        file_data = response.json()
        
        if 'url' in file_data:
            # Store in cache
            cache_set("file_urls", file_data['url'], cache_key)
            return file_data['url']
            
        print(f"Warning: No URL found in file data for file {file_id}")
        return None
        
    except requests.RequestException as e:
        import traceback, sys
        print(f"Error connecting to Canvas API for file URL: {e}")
        print(f"Line number: {sys.exc_info()[-1].tb_lineno}")
        print(traceback.format_exc())
        return None
    except Exception as e:
        import traceback, sys
        print(f"Unexpected error in get_file_url: {e}")
        print(f"Line number: {sys.exc_info()[-1].tb_lineno}")
        print(traceback.format_exc())
        return None
    
def encode_image_to_base64(image_path):
    """Encode an image to base64 for use with Gemini"""
    with open(image_path, "rb") as image_file:
        encoded_string = base64.b64encode(image_file.read()).decode("utf-8")
    
    # Get MIME type
    mime_type, _ = mimetypes.guess_type(image_path)
    if not mime_type:
        # Default to png if can't determine type
        mime_type = "image/png"
    
    return encoded_string, mime_type

def analyze_image_with_gemini(image_path):
    """
    Use Gemini to analyze an image and extract the learning concept
    Returns a description of the concept in the image
    """
    try:
        # Check if API key is available
        api_key = os.getenv('GOOGLE_API_KEY')
        if not api_key:
            print("Error: GOOGLE_API_KEY environment variable not set")
            return None
        
        # Initialize Gemini
        genai.configure(api_key=api_key)
        
        # Create a model instance for multimodal generation
        model = genai.GenerativeModel('gemini-1.5-flash')
        
        # Check if file exists
        if not os.path.exists(image_path):
            print(f"Error: Image file does not exist: {image_path}")
            return None
            
        # Encode image
        try:
            image_data, mime_type = encode_image_to_base64(image_path)
        except Exception as e:
            print(f"Error encoding image: {e}")
            return None
        
        # Create the prompt for image analysis
        prompt = """
        This is an educational image. Please analyze it and extract the main learning concept 
        or topic being illustrated. Describe what subject area this relates to and any key 
        terminology visible in the image. Give your response as a detailed query that I could
        use to find learning resources about this topic.
        """
        
        # Prepare the image for the API
        image_parts = [
            {
                "mime_type": mime_type,
                "data": image_data
            }
        ]
        
        # Generate content with the image
        try:
            response = model.generate_content([prompt, *image_parts])
            # Extract the query from the response
            return response.text
        except Exception as e:
            import traceback, sys
            print(f"Error from Gemini API for image analysis: {e}")
            print(f"Line number: {sys.exc_info()[-1].tb_lineno}")
            print(traceback.format_exc())
            return None
            
    except Exception as e:
        import traceback, sys
        print(f"Unexpected error in analyze_image_with_gemini: {e}")
        print(f"Line number: {sys.exc_info()[-1].tb_lineno}")
        print(traceback.format_exc())
        return None

def analyze_query_with_gemini(query, courses, course_modules=None):
    """
    Use Gemini to analyze the student's query and determine relevant course and modules
    Returns a dict with course_id, module_ids, and reasoning
    """
    # Check cache first
    if course_modules is None:
        # First stage: identify the correct course
        cache_key = query.lower()[:100]  # Limit key size
        cached_analysis = cache_get("course_analysis", cache_key)
        if cached_analysis:
            print(f"Using cached course analysis for query: {query[:30]}...")
            return cached_analysis
    else:
        # Second stage: identify relevant modules
        course_id = next(iter(courses.values()))  # Get any course ID to use in cache key
        cache_key = f"{course_id}_{query.lower()[:100]}"  # Limit key size
        cached_analysis = cache_get("module_analysis", cache_key)
        if cached_analysis:
            print(f"Using cached module analysis for query: {query[:30]}...")
            return cached_analysis
    
    try:
        # Check if API key is available
        api_key = os.getenv('GOOGLE_API_KEY') or "AIzaSyAkgIwBlXvh67IuCVvi0ZNvtjQDcB-RyVg"
        if not api_key:
            print("Error: GOOGLE_API_KEY environment variable not set")
            return None
        
        # Initialize Gemini
        genai.configure(api_key=api_key)
        
        # Create a model instance
        model = genai.GenerativeModel('gemini-1.5-flash')
        
        # Format the courses as a list for the prompt
        courses_list = "\n".join([f"- {name}" for name, id in courses.items()])
        
        # Create the initial prompt to identify the course
        if course_modules is None:
            # First stage: identify the correct course
            prompt = f"""
            You are an AI assistant for educational content. A student has the following question:
            
            "{query}"
            
            Based on this question, which of the following courses is the student most likely referring to? 
            Be very specific in your match and don't default to the first course unless absolutely necessary.
            Look for subject matter keywords in the query and match them to the course titles.
            
            Provide your answer as a JSON object with the fields: 
            - course_name: The name of the most relevant course (MUST exactly match one of the provided course names)
            - confidence: A score from 0-1 indicating your confidence
            - reasoning: A brief explanation of why you chose this course
            
            Available courses:
            {courses_list}
            
            Think step by step:
            1. What subjects or topics does the query mention?
            2. Which course titles contain similar subjects or topics?
            3. Only choose a course if you're confident there's a good match
            4. If there's no clear match, select the most general course that might cover the topic
            
            IMPORTANT: Return only the JSON object without any formatting, markdown, or code blocks.
            """
            
            # Add timeout to prevent hanging requests
            response = model.generate_content(prompt)
            try:
                # Clean the response text to handle potential markdown code blocks
                response_text = response.text
                
                # Check if response contains markdown code blocks
                if "```json" in response_text:
                    # Extract the JSON content from between the code block markers
                    import re
                    json_match = re.search(r'```json\s*(.*?)\s*```', response_text, re.DOTALL)
                    if json_match:
                        response_text = json_match.group(1)
                    else:
                        # If we can't extract with regex, try a simpler approach
                        response_text = response_text.replace("```json", "").replace("```", "")
                
                # Parse the result to get the course
                result = json.loads(response_text)
                
                # Validate the course name to ensure it's in the list
                if "course_name" in result and result["course_name"] not in courses:
                    print(f"Warning: Gemini returned an invalid course name: {result['course_name']}")
                    
                    # Try to find a close match
                    best_match = None
                    best_score = 0
                    for name in courses:
                        # Simple similarity score based on character overlap
                        similarity = sum(1 for a, b in zip(name.lower(), result["course_name"].lower()) if a == b)
                        score = similarity / max(len(name), len(result["course_name"]))
                        if score > best_score:
                            best_score = score
                            best_match = name
                    
                    if best_score > 0.5:
                        print(f"Found close match: {best_match} (score: {best_score})")
                        result["course_name"] = best_match
                        result["reasoning"] += f" (fixed invalid course name to closest match)"
                    else:
                        return None
                
                # Cache the result
                cache_set("course_analysis", result, cache_key)
                
                return result
            except Exception as e:
                # Fallback if the response isn't proper JSON
                import traceback, sys
                print(f"Error parsing Gemini response: {e}")
                print(f"Line number: {sys.exc_info()[-1].tb_lineno}")
                print(traceback.format_exc())
                print(f"Response text: {response.text}")
                return None
        else:
            # Second stage: identify relevant modules in the course
            modules_list = "\n".join([f"- {module['name']}" for module in course_modules])
            
            prompt = f"""
            You are an AI assistant for educational content. A student has the following question:
            
            "{query}"
            
            Based on this question, which of the following modules in the course are most relevant?
            Return a JSON object with:
            - module_names: An array of names of the most relevant modules (maximum 3)
            - relevance_explanations: Brief explanation for each module's relevance
            
            Available modules:
            {modules_list}
            
            Think step by step:
            1. What specific topics or concepts does the query ask about?
            2. Which module titles seem to cover these topics?
            3. Choose modules that are most likely to contain resources answering the query
            
            IMPORTANT: Return only the JSON object without any formatting, markdown, or code blocks.
            """
            
            # Add timeout to prevent hanging requests
            response = model.generate_content(prompt)
            try:
                # Clean the response text to handle potential markdown code blocks
                response_text = response.text
                
                # Check if response contains markdown code blocks
                if "```json" in response_text:
                    # Extract the JSON content from between the code block markers
                    import re
                    json_match = re.search(r'```json\s*(.*?)\s*```', response_text, re.DOTALL)
                    if json_match:
                        response_text = json_match.group(1)
                    else:
                        # If we can't extract with regex, try a simpler approach
                        response_text = response_text.replace("```json", "").replace("```", "")
                
                # Parse the result to get the modules
                result = json.loads(response_text)
                
                # Validate module names
                if "module_names" in result:
                    valid_module_names = [module["name"] for module in course_modules]
                    valid_results = []
                    
                    for name in result["module_names"]:
                        if name in valid_module_names:
                            valid_results.append(name)
                        else:
                            print(f"Warning: Invalid module name from Gemini: {name}")
                            # Try to find a close match
                            for valid_name in valid_module_names:
                                if name.lower() in valid_name.lower() or valid_name.lower() in name.lower():
                                    print(f"Found close match: {valid_name}")
                                    valid_results.append(valid_name)
                                    break
                    
                    # Update with only valid module names
                    result["module_names"] = valid_results
                    
                    # If no valid modules found, return None
                    if not valid_results:
                        return None
                
                # Cache the result
                course_id = next(iter(courses.values()))  # Get any course ID to use in cache key
                cache_key = f"{course_id}_{query.lower()[:100]}"
                cache_set("module_analysis", result, cache_key)
                
                return result
            except Exception as e:
                # Fallback if the response isn't proper JSON
                import traceback, sys
                print(f"Error parsing Gemini response: {e}")
                print(f"Line number: {sys.exc_info()[-1].tb_lineno}")
                print(traceback.format_exc())
                print(f"Response text: {response.text}")
                return None
    except Exception as e:
        import traceback, sys
        print(f"Error in analyze_query_with_gemini: {e}")
        print(f"Line number: {sys.exc_info()[-1].tb_lineno}")
        print(traceback.format_exc())
        return None

def analyze_resource_relevance(query, resource_items, course_name, module_name):
    """
    Use Gemini to analyze which resources are most relevant to the student's query
    """
    # Check cache first
    cache_key = f"{course_name}_{module_name}_{query.lower()[:100]}"
    cached_analysis = cache_get("resource_analysis", cache_key)
    if cached_analysis:
        print(f"Using cached resource analysis for module {module_name}")
        return cached_analysis
    
    try:
        # Check if API key is available
        api_key = os.getenv('GOOGLE_API_KEY') or "AIzaSyAkgIwBlXvh67IuCVvi0ZNvtjQDcB-RyVg"
        if not api_key:
            print("Error: GOOGLE_API_KEY environment variable not set")
            return None
        
        # Initialize Gemini
        genai.configure(api_key=api_key)
        
        # Create a model instance
        model = genai.GenerativeModel('gemini-1.5-flash')
        
        # Optimize: Only include essential information for each resource
        resources_list = "\n".join([f"- {idx}: {item.get('title', 'Untitled')} (Type: {item.get('type', 'Unknown')})" 
                                for idx, item in enumerate(resource_items)])
        
        prompt = f"""
        You are an AI assistant for educational content. A student has the following question:
        
        "{query}"
        
        This question relates to the course "{course_name}" in the module "{module_name}".
        
        Based on this question, which of the following resources would be most helpful to the student?
        Return a JSON object with:
        - resource_indices: An array of indices (0-based) of the most relevant resources (maximum 5)
        - relevance_scores: An array of relevance scores (0-1) corresponding to each resource
        - reasoning: Brief explanation of why these resources are relevant
        
        Available resources:
        {resources_list}
        
        IMPORTANT: Return only the JSON object without any formatting, markdown, or code blocks.
        """
        
        try:
            # Generate content without timeout
            response = model.generate_content(prompt)
            
            # Clean the response text to handle potential markdown code blocks
            response_text = response.text
                
            # Check if response contains markdown code blocks
            if "```json" in response_text:
                # Extract the JSON content from between the code block markers
                import re
                json_match = re.search(r'```json\s*(.*?)\s*```', response_text, re.DOTALL)
                if json_match:
                    response_text = json_match.group(1)
                else:
                    # If we can't extract with regex, try a simpler approach
                    response_text = response_text.replace("```json", "").replace("```", "")
            
            # Parse the result to get the relevant resources
            result = json.loads(response_text)
            
            # Cache the result
            cache_set("resource_analysis", result, cache_key)
            
            return result
        except json.JSONDecodeError as e:
            # Fallback if the response isn't proper JSON
            import traceback, sys
            print(f"Error parsing Gemini response for resource relevance: {e}")
            print(f"Line number: {sys.exc_info()[-1].tb_lineno}")
            print(traceback.format_exc())
            print(f"Response text: {response.text}")
            return None
        except Exception as e:
            import traceback, sys
            print(f"Error from Gemini API for resource relevance: {e}")
            print(f"Line number: {sys.exc_info()[-1].tb_lineno}")
            print(traceback.format_exc())
            return None
            
    except Exception as e:
        import traceback, sys
        print(f"Unexpected error in analyze_resource_relevance: {e}")
        print(f"Line number: {sys.exc_info()[-1].tb_lineno}")
        print(traceback.format_exc())
        return None

@mcp.tool()
async def find_resources(query: str, image_path: Optional[str] = None):
    """Use this tool to search for and identify the most relevant learning resources across Canvas courses based on a text query or image. This tool analyzes user needs and returns resources ranked by relevance. Use this when helping users find specific learning materials, lecture notes, or content related to their questions."""
    try:
        print(f"Processing query: {query}, image_path: {image_path}")
        
        # Validate inputs
        if not query and not image_path:
            return {"error": "Either query or image_path must be provided"}
            
        # Check if image path exists when provided
        if image_path and not os.path.exists(image_path):
            print(f"Warning: Image path does not exist: {image_path}")
            if not query:
                return {"error": "Image path provided does not exist and no query was provided"}
        
        # Call helper_resources with proper error handling
        result = await helper_resources(query, image_path)
        if not result:
            return {"error": "Failed to find resources", "message": "Resource search returned no results"}
            
        # Check if result indicates an error
        if isinstance(result, list) and len(result) > 0 and "error" in result[0]:
            return result[0]
            
        return result
        
    except Exception as e:
        # Log the error
        import traceback, sys
        error_msg = f"Error processing request: {str(e)}"
        line_num = sys.exc_info()[-1].tb_lineno
        print(f"{error_msg} at line {line_num}")
        print(traceback.format_exc())
        
        # Return a proper error response
        return {"error": "Internal server error", "message": str(e), "line": line_num}

async def process_module(course_id, module, query, course_name):
    """Process a single module and return relevant resources"""
    module_id = module["id"]
    module_name = module["name"]
    
    print(f"Getting items for module: {module_name} (ID: {module_id})")
    
    # Get all items in this module
    items = await get_module_items(course_id, module_id)
    
    if not items:
        print(f"No items found in module: {module_name}")
        return []
    
    print(f"Found {len(items)} items in module: {module_name}")
    
    # Analyze which resources are most relevant within this module
    resource_analysis = analyze_resource_relevance(query, items, course_name, module_name)
    if not resource_analysis:
        print(f"Failed to analyze resource relevance for module: {module_name}")
        return []
        
    relevant_indices = resource_analysis.get("resource_indices", [])
    relevance_scores = resource_analysis.get("relevance_scores", [])
    
    if not relevant_indices:
        print(f"No relevant resources identified in module: {module_name}")
        return []
        
    print(f"Relevant indices from analysis: {relevant_indices}")
    
    # Add the relevant resources to our results
    relevant_resources = []
    file_url_tasks = []
    
    for idx_pos, idx in enumerate(relevant_indices):
        if idx < len(items):
            item = items[idx]
            # Format the resource for the response
            resource = {
                "title": item.get("title", "Untitled Resource"),
                "type": item.get("type", "Unknown"),
                "url": item.get("html_url", ""),
                "course": course_name,
                "module": module_name,
                "relevance_score": relevance_scores[idx_pos] if idx_pos < len(relevance_scores) else 0.5,
                "item": item  # Save the original item for file URL resolution
            }
            
            relevant_resources.append(resource)
    
    # Process file URLs in parallel
    for resource in relevant_resources:
        item = resource.pop("item")  # Remove the item from the resource
        if item.get("type") == "File" and "content_id" in item:
            file_url = await get_file_url(course_id, item["content_id"])
            if file_url:
                resource["url"] = file_url
    
    return relevant_resources

async def helper_resources(query, image_path=None):
    """
    Main function to find resources based on a student query or image
    Returns a list of relevant resources
    """
    # If an image is provided, analyze it to get a query
    if image_path and os.path.exists(image_path):
        print(f"Analyzing image: {image_path}")
        image_query = analyze_image_with_gemini(image_path)
        # Combine the original query with the image analysis if image analysis was successful
        if image_query and query:
            query = f"{query} - {image_query}"
        elif image_query:
            query = image_query
        print(f"Image analysis result: {image_query if image_query else 'Failed to analyze image'}")
    
    # Step 1: Get all courses
    courses = await get_courses()
    if not courses:
        print("Error: No courses found from Canvas API")
        return [{"error": "No courses found", "details": "Please check your Canvas API configuration"}]
    
    # Print available courses for debugging
    print(f"Available courses: {list(courses.keys())}")
    
    # Step 2: Analyze the query to identify the relevant course
    print(f"Analyzing query: '{query}'")
    course_analysis = analyze_query_with_gemini(query, courses)
    if not course_analysis:
        print("Error: Failed to analyze query to determine relevant course")
        return [{"error": "Failed to analyze query", "details": "Could not determine relevant course"}]
        
    course_name = course_analysis.get("course_name")
    confidence = course_analysis.get("confidence", 0)
    reasoning = course_analysis.get("reasoning", "No reasoning provided")
    
    print(f"Course analysis result: {course_name} (confidence: {confidence})")
    print(f"Reasoning: {reasoning}")
    
    # Improved course matching logic
    if course_name not in courses:
        print(f"Exact course match not found for '{course_name}', trying partial matches")
        # Try to find a partial match with higher threshold
        best_match = None
        best_match_score = 0
        
        for name in courses:
            # Check for significant word overlap
            query_words = set(w.lower() for w in query.split() if len(w) > 3)
            name_words = set(w.lower() for w in name.split() if len(w) > 3)
            
            # Calculate overlap score
            if query_words and name_words:
                overlap = len(query_words.intersection(name_words))
                score = overlap / min(len(query_words), len(name_words))
                print(f"Course: {name}, score: {score}")
                
                if score > best_match_score:
                    best_match_score = score
                    best_match = name
            
            # Also check for simple substring match
            elif course_name.lower() in name.lower() or name.lower() in course_name.lower():
                print(f"Substring match found: {name}")
                if best_match is None:
                    best_match = name
        
        if best_match and best_match_score >= 0.2:
            print(f"Using best match course: {best_match} (score: {best_match_score})")
            course_name = best_match
        elif best_match:
            print(f"Using substring match course: {best_match}")
            course_name = best_match
        else:
            # If still no match found, check if there's a course related to the query topic
            query_keywords = [w.lower() for w in query.split() if len(w) > 4]
            
            for name in courses:
                for keyword in query_keywords:
                    if keyword in name.lower():
                        print(f"Keyword match found: {name} (keyword: {keyword})")
                        course_name = name
                        break
                if course_name in courses:
                    break
            
            # Last resort - default to first course
            if course_name not in courses:
                print("No course match found and couldn't determine a relevant course")
                return [{"error": "No relevant course found", "query": query}]
    
    course_id = courses[course_name]
    print(f"Selected course: {course_name} (ID: {course_id})")
    
    # Step 3: Get modules for the identified course
    modules = await get_modules(course_id)
    if not modules:
        print(f"No modules found for course: {course_name}")
        return [{"error": "No modules found", "course": course_name}]
    
    print(f"Found {len(modules)} modules in course {course_name}")
    
    # Step 4: Analyze which modules are most relevant
    module_analysis = analyze_query_with_gemini(query, courses, modules)
    if not module_analysis:
        print("Error: Failed to analyze query to determine relevant modules")
        return [{"error": "Failed to analyze query", "details": "Could not determine relevant modules"}]
        
    relevant_module_names = module_analysis.get("module_names", [])
    
    print(f"Relevant module names from analysis: {relevant_module_names}")
    
    # Map module names to IDs
    relevant_modules = []
    for module in modules:
        if module["name"] in relevant_module_names:
            print(f"Found exact module match: {module['name']}")
            relevant_modules.append(module)
        # If we can't find exact matches, include modules that contain the query keywords
        elif any(keyword.lower() in module["name"].lower() 
                for keyword in query.lower().split() if len(keyword) > 3):
            print(f"Found keyword match in module: {module['name']}")
            relevant_modules.append(module)
    
    # If no relevant modules found
    if not relevant_modules:
        print("No relevant modules found for the query")
        return [{"error": "No relevant modules found", "course": course_name, "query": query}]
    
    print(f"Selected {len(relevant_modules)} modules for further analysis")
    
    # Step 5: Process modules in parallel
    module_tasks = [process_module(course_id, module, query, course_name) for module in relevant_modules]
    module_results = await asyncio.gather(*module_tasks)
    
    # Combine results from all modules
    all_relevant_resources = []
    for result in module_results:
        all_relevant_resources.extend(result)
    
    # Sort resources by relevance score (descending)
    if all_relevant_resources:
        all_relevant_resources.sort(key=lambda x: x.get("relevance_score", 0), reverse=True)
    
    # Return results, or an error if none found
    if all_relevant_resources:
        print(f"Returning {len(all_relevant_resources)} relevant resources")
        # Try to save resources to a json file, but don't fail if it's not possible (e.g., read-only filesystem)
        try:
            # Check if we're in a writable environment before attempting to write
            is_writable = os.access(os.getcwd(), os.W_OK)
            if is_writable:
                safe_query = "".join(c if c.isalnum() else "_" for c in query)[:50]  # Make filename safe
                with open(f"resources_{safe_query}.json", "w") as f:
                    json.dump(all_relevant_resources, f)
                print(f"Saved resources to resources_{safe_query}.json")
        except Exception as e:
            # Just log the error but continue
            print(f"Warning: Could not save resources to file: {e}")

        return all_relevant_resources
    else:
        print(f"No relevant resources found for query: {query}")
        return [{"error": "No relevant resources found", "query": query, "course": course_name}]

@mcp.tool()
async def get_course_assignments(course_id, bucket: str = None):
    """Use this tool to retrieve all assignments for a specific Canvas course, with optional filtering by status. This tool returns assignment details including name, description, due date, and submission status. Use this when helping users manage their coursework, check due dates, or find assignment details.
    
    Args:
        course_id: The Canvas course ID
        bucket: Optional filter - past, overdue, undated, ungraded, unsubmitted, upcoming, future
    """

    # if course_id is not a string, convert it to a string
    if not isinstance(course_id, str):
        course_id = str(course_id)

    try:
        # Build URL with optional bucket parameter
        url = f"https://canvas.asu.edu/api/v1/courses/{course_id}/assignments"
        params = {
            "order_by": "due_at",
            "per_page": 100,  # Get max assignments per page
            "include[]": ["submission", "all_dates"]  # Include submission details
        }
        if bucket:
            params["bucket"] = bucket
            
        # Check if API key is available
        api_key = os.getenv('CANVAS_API_KEY')
        if not api_key:
            print("Error: CANVAS_API_KEY environment variable not set")
            return None
            
        headers = {
            "Authorization": f"Bearer {api_key}"
        }
        
        # Add timeout to prevent hanging
        response = requests.get(url, headers=headers, params=params, timeout=10)
        
        # Check response status
        if response.status_code != 200:
            print(f"Error: Canvas API returned status code {response.status_code}")
            print(f"Response: {response.text}")
            return None
            
        assignments = response.json()
        
        # Store in cache
        # cache_set("assignments", assignments, cache_key)

        # only return "id", "description", "due_at", "has_submitted_submissions" and "name" of the assignments
        return [{"id": assignment["id"], "description": assignment["description"], "due_at": assignment["due_at"], "has_submitted_submissions": assignment["has_submitted_submissions"], "name": assignment["name"]} for assignment in assignments]


    except Exception as e:
        import traceback, sys
        print(f"Unexpected error in get_course_assignments: {e}")
        print(f"Line number: {sys.exc_info()[-1].tb_lineno}")
        print(traceback.format_exc())
        return None

@mcp.tool()
async def get_assignments_by_course_name(course_name: str, bucket: str = None):
    """Use this tool to retrieve all assignments for a Canvas course using its name rather than ID. This tool returns assignment details the same as get_course_assignments. Use this when you have the course name but not the ID, or when helping users find assignments across multiple courses.
    
    Args:
        course_name: The name of the course as it appears in Canvas (partial matches supported)
        bucket: Optional filter - past, overdue, undated, ungraded, unsubmitted, upcoming, future
    """
    try:
        # First get all courses to find the course ID
        courses = await get_courses()
        if not courses:
            print("Error: Could not fetch courses")
            return None
        
        course_found = False

        for courseName, courseId in courses.items():
            if course_name in courseName:
                course_id = courseId
                course_found = True
                break
            
        # Find the course ID by name
        if not course_found:
            print(f"Error: Course '{course_name}' not found")
            print(f"Available courses: {list(courses.keys())}")
            return None
            
        # Get assignments using the course ID
        return await get_course_assignments(course_id, bucket)
        
    except Exception as e:
        import traceback, sys
        print(f"Unexpected error in get_assignments_by_course_name: {e}")
        print(f"Line number: {sys.exc_info()[-1].tb_lineno}")
        print(traceback.format_exc())
        return None

# @mcp.tool()
# async def get_gradescope_course_by_name(course_name: str):
#     """Get a course from Gradescope by name"""
#     courses = await get_gradescope_courses()
#     for course in courses["student"].values():
#         if course_name in course["name"] or course_name in course["full_name"]:
#             return course
#     return None

# Add test functions
async def test_assignments():
    """Test the assignment functions"""
    print("\nTesting assignment functions...")
    
    # Test get_course_assignments
    print("\nTesting get_course_assignments...")
    courses = await get_courses()
    if courses:
        first_course_id = next(iter(courses.values()))
        print(f"Testing with first course ID: {first_course_id}")
        
        # Test without bucket
        assignments = await get_course_assignments(first_course_id)
        print(f"Found {len(assignments) if assignments else 0} assignments without bucket")
        
        # Test with bucket
        upcoming = await get_course_assignments(first_course_id, "upcoming")
        print(f"Found {len(upcoming) if upcoming else 0} upcoming assignments")
    
    # Test get_assignments_by_course_name
    print("\nTesting get_assignments_by_course_name...")
    if courses:
        first_course_name = next(iter(courses.keys()))
        print(f"Testing with first course name: {first_course_name}")
        
        # Test without bucket
        assignments = await get_assignments_by_course_name(first_course_name)
        print(f"Found {len(assignments) if assignments else 0} assignments without bucket")
        
        # Test with bucket
        upcoming = await get_assignments_by_course_name(first_course_name, "upcoming")
        print(f"Found {len(upcoming) if upcoming else 0} upcoming assignments")

# Add MCP tools for Gradescope

@mcp.tool()
async def get_canvas_courses():
    """Use this tool to retrieve all available Canvas courses for the current user. This is an alias for get_courses. Use this when you need to find course IDs based on names or display all available courses."""
    return await get_courses()

@mcp.tool()
async def get_gradescope_courses(random_string: str = ""):
    """Use this tool to retrieve all available Gradescope courses for the current user. This tool returns a dictionary of courses organized by user role. Use this when helping users access or manage their Gradescope course information."""
    return gradescope._get_gradescope_courses()

@mcp.tool()
async def get_gradescope_course_by_name(course_name: str):
    """Use this tool to find a specific Gradescope course by name (partial matches supported). This tool returns the course object if found. Use this when you need to get course details or ID when only the name is known.
    
    Args:
        course_name: The name or partial name of the Gradescope course to search for
    """
    return gradescope.get_course_by_name(course_name)

@mcp.tool()
async def get_gradescope_assignments(course_id: str):
    """Use this tool to retrieve all assignments for a specific Gradescope course. This tool returns a list of assignment objects with details like name, due date, and status. Use this when helping users manage their Gradescope coursework.
    
    Args:
        course_id: The Gradescope course ID
    """
    return gradescope.get_assignments_for_course(course_id)

@mcp.tool()
async def get_gradescope_assignment_by_name(course_id: str, assignment_name: str):
    """Use this tool to find a specific Gradescope assignment by name within a course. This tool returns the assignment object if found. Use this when you need assignment details or ID when only the name and course are known.
    
    Args:
        course_id: The Gradescope course ID
        assignment_name: The name or partial name of the assignment to search for
    """
    return gradescope.get_assignment_by_name(course_id, assignment_name)

@mcp.tool()
async def get_gradescope_submissions(course_id: str, assignment_id: str):
    """Use this tool to retrieve all submissions for a specific Gradescope assignment. This tool returns a list of submission objects with details like submission time and score. Use this when helping users review or manage submission information.
    
    Args:
        course_id: The Gradescope course ID
        assignment_id: The Gradescope assignment ID
    """
    return gradescope.get_assignment_submissions(course_id, assignment_id)

@mcp.tool()
async def get_gradescope_student_submission(course_id: str, assignment_id: str, student_email: str):
    """Use this tool to retrieve a specific student's submission for a Gradescope assignment. This tool returns the submission object if found. Use this when helping a student review their own submission or when an instructor needs details about a specific student's work.
    
    Args:
        course_id: The Gradescope course ID
        assignment_id: The Gradescope assignment ID
        student_email: The email address of the student whose submission to retrieve
    """
    return gradescope.get_student_submission(course_id, assignment_id, student_email)

@mcp.tool()
async def call_search_gradescope(query: str):
    """Use this tool to search for information across Gradescope using natural language queries. This tool analyzes the query and returns relevant information about courses, assignments, or submissions. Use this when helping users find Gradescope information without knowing specific IDs or technical details.
    
    Args:
        query: Natural language query about Gradescope courses, assignments, etc.
    """
    # Analyze the query to determine what is being asked
    analysis = gradescope.analyze_gradescope_query(query)
    
    if analysis["type"] == "get_courses":
        # User is asking about courses
        courses = gradescope._get_gradescope_courses()
        if not courses:
            return {"error": "Could not retrieve Gradescope courses"}
        return courses
    
    elif analysis["type"] == "get_assignments":
        # User is asking about assignments
        course_id = analysis.get("course_id")
        course_name = analysis.get("course_name")
        
        # If we don't have a course ID but have a name, try to get the ID
        if not course_id and course_name:
            course = gradescope.get_course_by_name(course_name)
            if course:
                course_id = course.get("id")
        
        # If we still don't have a course ID, return an error
        if not course_id:
            # Try to get all courses and return that instead
            courses = gradescope._get_gradescope_courses()
            if courses:
                return {
                    "message": "Please specify which course you're interested in. Here are your courses:",
                    "courses": courses
                }
            else:
                return {"error": "Could not determine which course to get assignments for"}
        
        # Get assignments for the course
        assignments = gradescope.get_assignments_for_course(course_id)
        if not assignments:
            return {"error": f"No assignments found for the course {course_name or course_id}"}
        
        return assignments
    
    elif analysis["type"] == "get_submission":
        # User is asking about a submission
        course_id = analysis.get("course_id")
        course_name = analysis.get("course_name")
        assignment_id = analysis.get("assignment_id")
        assignment_name = analysis.get("assignment_name")
        
        # If we don't have a course ID but have a name, try to get the ID
        if not course_id and course_name:
            course = gradescope.get_course_by_name(course_name)
            if course:
                course_id = course.get("id")
        
        # If we don't have an assignment ID but have a name and course ID, try to get the ID
        if not assignment_id and assignment_name and course_id:
            assignment = gradescope.get_assignment_by_name(course_id, assignment_name)
            if assignment:
                assignment_id = assignment.id
        
        # If we still don't have both IDs, return an error
        if not course_id or not assignment_id:
            return {"error": "Could not determine which course or assignment to get submissions for"}
        
        # Get submissions for the assignment
        submissions = gradescope.get_assignment_submissions(course_id, assignment_id)
        if not submissions:
            return {"error": f"No submissions found for the assignment {assignment_name or assignment_id}"}
        
        return submissions
    
    else:
        # Unknown query type
        return {
            "error": "I'm not sure what you're asking about Gradescope. Try asking about your courses, assignments, or submissions."
        }

# Add tests for Gradescope functions
async def test_gradescope():
    """Test the Gradescope functions"""
    print("\nTesting Gradescope functions...")
    
    # Test get_gradescope_courses
    print("\nTesting get_gradescope_courses...")
    courses = await get_gradescope_courses()
    print(f"Found {len(courses['student']) if courses and 'student' in courses else 0} Gradescope courses")
    
    if courses and 'student' in courses and len(courses['student']) > 0:
        # Get a course name from the first course
        first_course = next(iter(courses['student'].values()))
        course_name = first_course['name']
        
        # Test mcp_get_gradescope_course_by_name
        print(f"\nTesting mcp_get_gradescope_course_by_name with '{course_name}'...")
        course = await get_gradescope_course_by_name(course_name)
        print(f"Found course: {course['name'] if course else None}")
        
        if course:
            course_id = course['id']
            
            # Test mcp_get_gradescope_assignments
            print(f"\nTesting mcp_get_gradescope_assignments for course '{course['name']}'...")
            assignments = await get_gradescope_assignments(course_id)
            print(f"Found {len(assignments) if assignments else 0} assignments")
            
            if assignments and len(assignments) > 0:
                # Test with first assignment
                assignment = assignments[0]
                print(f"\nTesting with assignment '{assignment.name}'...")
                
                # Fix: Access assignment ID correctly - investigate the structure of assignment objects
                # Print the assignment object structure for debugging
                print(f"Assignment object attributes: {dir(assignment)}")
                
                # Try different ways to access the ID - it might not be directly 'id'
                assignment_id = getattr(assignment, 'id', None)
                if assignment_id is None:
                    # Try to find the ID in other attributes
                    if hasattr(assignment, 'get_id'):
                        assignment_id = assignment.get_id()
                    elif hasattr(assignment, 'assignment_id'):
                        assignment_id = assignment.assignment_id
                    # Add more fallbacks if needed
                
                if assignment_id:
                    print(f"Using assignment ID: {assignment_id}")
                    
                    # Test mcp_get_gradescope_submissions
                    print(f"Testing mcp_get_gradescope_submissions...")
                    submissions = await get_gradescope_submissions(course_id, assignment_id)
                    print(f"Found submissions: {submissions is not None}")
                else:
                    print("Could not determine assignment ID. Skipping submission and extension tests.")
                
    # Test natural language search
    print("\nTesting mcp_search_gradescope...")
    search_result = await call_search_gradescope("What are my Gradescope courses?")
    print(f"Search result: {search_result is not None}")
    
    search_result2 = await call_search_gradescope("Show me my assignments")
    print(f"Search result 2: {search_result2 is not None}")

@mcp.tool()
async def search_education_platforms(query: str):
    """Use this tool to search for information across both Canvas and Gradescope using natural language queries. This tool determines which platform is most relevant to the query and returns appropriately formatted results. Use this for broad educational queries when the user hasn't specified which platform they're interested in.
    
    Args:
        query: Natural language query about courses, assignments, or other educational content
    """
    # First, determine if the query is related to Canvas or Gradescope
    canvas_keywords = ["canvas", "module", "resource", "course page", "page", "learning module", "file", "lecture"]
    gradescope_keywords = ["gradescope", "assignment", "submission", "grade", "score", "feedback", "due date", "deadline"]
    
    # Count matches for each platform
    canvas_matches = sum(1 for keyword in canvas_keywords if keyword.lower() in query.lower())
    gradescope_matches = sum(1 for keyword in gradescope_keywords if keyword.lower() in query.lower())
    
    # Handle general queries about academics or courses that don't specifically mention a platform
    if "course" in query.lower() and canvas_matches == 0 and gradescope_matches == 0:
        # Check both platforms
        results = {"canvas": {}, "gradescope": {}}
        
        # Get Canvas courses
        try:
            canvas_courses = await get_courses()
            if canvas_courses:
                results["canvas"]["courses"] = canvas_courses
        except Exception as e:
            print(f"Error fetching Canvas courses: {e}")
        
        # Get Gradescope courses
        try:
            gradescope_courses = await get_gradescope_courses()
            if gradescope_courses:
                results["gradescope"]["courses"] = gradescope_courses
        except Exception as e:
            print(f"Error fetching Gradescope courses: {e}")
            
        return {
            "message": "Here are your courses from both Canvas and Gradescope:",
            "results": results
        }
    
    # If the query seems more related to Canvas
    if canvas_matches > gradescope_matches or "canvas" in query.lower():
        # Use the Canvas resource finder
        try:
            resources = await find_resources(query=query)
            return {
                "message": "Here are the most relevant Canvas resources for your query:",
                "source": "Canvas",
                "resources": resources
            }
        except Exception as e:
            print(f"Error searching Canvas: {e}")
            return {"error": f"Error searching Canvas: {str(e)}"}
    
    # If the query seems more related to Gradescope
    elif gradescope_matches > canvas_matches or "gradescope" in query.lower():
        # Use the Gradescope search
        try:
            results = await call_search_gradescope(query)
            return {
                "message": "Here are the Gradescope results for your query:",
                "source": "Gradescope",
                "results": results
            }
        except Exception as e:
            print(f"Error searching Gradescope: {e}")
            return {"error": f"Error searching Gradescope: {str(e)}"}
    
    # If we can't determine which platform, search both
    else:
        combined_results = {"canvas": None, "gradescope": None}
        
        # Try Canvas first
        try:
            canvas_results = await find_resources(query=query)
            combined_results["canvas"] = canvas_results
        except Exception as e:
            print(f"Error searching Canvas: {e}")
        
        # Then try Gradescope
        try:
            gradescope_results = await call_search_gradescope(query)
            combined_results["gradescope"] = gradescope_results
        except Exception as e:
            print(f"Error searching Gradescope: {e}")
        
        return {
            "message": "Here are results from both Canvas and Gradescope for your query:",
            "results": combined_results
        }

# Add a test for the unified search function
async def test_unified_search():
    """Test the unified search function"""
    print("\nTesting unified search...")
    
    # Test a Canvas-specific query
    print("\nTesting Canvas-specific query...")
    canvas_result = await search_education_platforms("What resources are available for learning matrices in Canvas?")
    print(f"Canvas search result: {canvas_result is not None}")
    
    # Test a Gradescope-specific query
    print("\nTesting Gradescope-specific query...")
    gradescope_result = await search_education_platforms("Show me my Gradescope assignments")
    print(f"Gradescope search result: {gradescope_result is not None}")
    
    # Test a general query
    print("\nTesting general query...")
    general_result = await search_education_platforms("What courses am I enrolled in?")
    print(f"General search result: {general_result is not None}")

# Update run_tests to include the unified search test
async def run_tests():
    # Existing tests
    out = await find_resources(query="what would be the best resources to learn dot product of matrices from canvas?")
    print(out)

    print("="*50)
    
    # Add assignment tests
    await test_assignments()

    print("="*50)

    # Get assignments for Linear Algebra
    assignments = await get_assignments_by_course_name("Linear Algebra")
    print(assignments)

    with open("assignments.json", "w") as f:
        json.dump(assignments, f)
    
    print("="*50)
    
    # Add Gradescope tests
    await test_gradescope()
    
    print("="*50)
    
    # Add unified search test
    await test_unified_search()

if __name__ == "__main__":
    if len(sys.argv) == 1:
        # Initialize and run the server
        mcp.run(transport='stdio')
    else:
        # Run tests
        asyncio.run(run_tests())
