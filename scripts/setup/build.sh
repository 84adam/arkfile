#!/bin/bash
set -e

# Configuration
APP_NAME="arkfile"
WASM_DIR="client"
BUILD_DIR="build"
VERSION=$(git describe --tags --always --dirty)
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
BASE_DIR="/opt/arkfile"

# Colors for output 
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Function to check Go version requirements from go.mod
check_go_version() {
    local required_version=$(grep '^go [0-9]' go.mod | awk '{print $2}')
    
    if [ -z "$required_version" ]; then
        echo -e "${YELLOW}⚠️  Cannot determine Go version requirement from go.mod${NC}"
        return 0
    fi
    
    local current_version=$(go version | grep -o 'go[0-9]\+\.[0-9]\+\.[0-9]\+' | sed 's/go//')
    
    if [ -z "$current_version" ]; then
        echo -e "${RED}❌ Cannot determine Go version${NC}"
        exit 1
    fi
    
    # Convert versions to comparable format (remove dots and compare as integers)
    local current_num=$(echo $current_version | awk -F. '{printf "%d%02d%02d", $1, $2, $3}')
    local required_num=$(echo $required_version | awk -F. '{printf "%d%02d%02d", $1, $2, $3}')
    
    if [ "$current_num" -lt "$required_num" ]; then
        echo -e "${RED}❌ Go version $current_version is too old${NC}"
        echo -e "${YELLOW}Required: Go $required_version or later (from go.mod)${NC}"
        echo -e "${YELLOW}Current:  Go $current_version${NC}"
        echo
        echo -e "${BLUE}To update Go:${NC}"
        echo "1. Visit https://golang.org/dl/"
        echo "2. Download and install Go $required_version or later"
        echo "3. Or use your system's package manager"
        exit 1
    fi
    
    echo -e "${GREEN}✅ Go version $current_version meets requirements (>= $required_version)${NC}"
}

# Ensure required tools are installed
command -v go >/dev/null 2>&1 || { echo -e "${RED}Go is required but not installed.${NC}" >&2; exit 1; }
check_go_version

# Ensure Go dependencies are properly resolved
echo -e "${YELLOW}Checking Go module dependencies...${NC}"
if ! go mod download; then
    echo -e "${YELLOW}Dependencies need updating, running go mod tidy...${NC}"
    go mod tidy
    if ! go mod download; then
        echo -e "${RED}Failed to resolve Go dependencies${NC}" >&2
        exit 1
    fi
fi
echo -e "${GREEN}✅ Go dependencies resolved${NC}"

# Initialize and build C dependencies
echo -e "${YELLOW}Initializing and building C dependencies...${NC}"
if [ -f "vendor/aldenml/ecc/CMakeLists.txt" ]; then
    echo "Found aldenml/ecc submodule..."
    (cd vendor/aldenml/ecc && git submodule update --init --recursive && mkdir -p build && cd build && cmake .. && make)
    echo -e "${GREEN}✅ C dependencies built successfully${NC}"
else
    echo -e "${RED}❌ aldenml/ecc submodule not found. Please run 'git submodule update --init --recursive'${NC}"
    exit 1
fi

# Run user and directory setup if needed
if [ ! -d "${BASE_DIR}" ]; then
    echo -e "${YELLOW}Setting up initial directory structure...${NC}"
    ./scripts/setup/01-setup-users.sh
    ./scripts/setup/02-setup-directories.sh
fi

echo -e "${GREEN}Building ${APP_NAME} version ${VERSION}${NC}"

# Stop arkfile service if it's running to avoid "text file busy" errors
if systemctl is-active --quiet arkfile 2>/dev/null; then
    echo -e "${YELLOW}Stopping arkfile service for rebuild...${NC}"
    sudo systemctl stop arkfile
    # Wait a moment for the service to fully stop
    sleep 2
    
    # Kill any remaining arkfile processes
    if pgrep -f "arkfile" > /dev/null; then
        echo "Terminating remaining arkfile processes..."
        sudo pkill -f "arkfile" 2>/dev/null || true
        sleep 1
        
        # Force kill if still running
        if pgrep -f "arkfile" > /dev/null; then
            echo "Force killing remaining arkfile processes..."
            sudo pkill -9 -f "arkfile" 2>/dev/null || true
            sleep 1
        fi
    fi
    
    echo -e "${GREEN}Service stopped successfully${NC}"
fi

# Create temporary build directory
mkdir -p ${BUILD_DIR}

# Build WebAssembly
echo "Building WebAssembly..."
GOOS=js GOARCH=wasm go build -o ${BUILD_DIR}/${WASM_DIR}/main.wasm ./${WASM_DIR}/main.go

# Find wasm_exec.js using Go's environment
GOROOT=$(go env GOROOT)
WASM_EXEC_JS=""
if [ -f "${GOROOT}/lib/wasm/wasm_exec.js" ]; then
    WASM_EXEC_JS="${GOROOT}/lib/wasm/wasm_exec.js"
elif [ -f "${GOROOT}/misc/wasm/wasm_exec.js" ]; then
    WASM_EXEC_JS="${GOROOT}/misc/wasm/wasm_exec.js"
else
    echo -e "${RED}❌ Cannot find wasm_exec.js in Go installation at ${GOROOT}${NC}"
    exit 1
fi

echo "Using wasm_exec.js from: ${WASM_EXEC_JS}"
cp "${WASM_EXEC_JS}" ${BUILD_DIR}/${WASM_DIR}/

# Build main application with version information
echo "Building main application..."
go build -ldflags "-X main.Version=${VERSION} -X main.BuildTime=${BUILD_TIME}" -o ${BUILD_DIR}/${APP_NAME}

# Copy static files
echo "Copying static files..."
cp -r client/static ${BUILD_DIR}/static

# Setup error pages in webroot
echo "Setting up error pages..."
mkdir -p ${BUILD_DIR}/webroot/errors
cp client/static/errors/* ${BUILD_DIR}/webroot/errors/

# Copy systemd service files
echo "Copying systemd service files..."
mkdir -p ${BUILD_DIR}/systemd
cp systemd/* ${BUILD_DIR}/systemd/

# Create version file
echo "Creating version file..."
cat > ${BUILD_DIR}/version.json <<EOF
{
   "version": "${VERSION}",
   "buildTime": "${BUILD_TIME}"
}
EOF

# Create release directory with timestamp
RELEASE_DIR="${BASE_DIR}/releases/$(date +%Y%m%d_%H%M%S)"
echo "Creating release directory: ${RELEASE_DIR}"

# Copy build artifacts to release directory
sudo mkdir -p "${RELEASE_DIR}"
sudo cp -r ${BUILD_DIR}/* "${RELEASE_DIR}/"

# Update ownership and permissions
echo "Setting ownership and permissions..."
sudo chown -R arkadmin:arkfile "${RELEASE_DIR}"
sudo chmod 755 "${RELEASE_DIR}/${APP_NAME}"

if command -v semanage >/dev/null 2>&1; then
    sudo semanage fcontext -a -t bin_t "${RELEASE_DIR}/${APP_NAME}"
    sudo restorecon -v "${RELEASE_DIR}/${APP_NAME}"
else
    echo -e "${YELLOW}semanage not found - skipping SELinux context${NC}"
fi

# Update the 'current' symlink
sudo ln -snf "${RELEASE_DIR}" "${BASE_DIR}/releases/current"

# Copy binary to bin directory
sudo cp "${RELEASE_DIR}/${APP_NAME}" "${BASE_DIR}/bin/"
sudo chown arkadmin:arkfile "${BASE_DIR}/bin/${APP_NAME}"
sudo chmod 755 "${BASE_DIR}/bin/${APP_NAME}"

# Copy database files to working directory for runtime access
echo "Copying database files to working directory..."
sudo mkdir -p "${BASE_DIR}/database"
sudo cp -r database/* "${BASE_DIR}/database/"
sudo chown -R arkfile:arkfile "${BASE_DIR}/database"

# Copy client files to working directory for runtime access
echo "Copying client files to working directory..."
sudo mkdir -p "${BASE_DIR}/client"
sudo cp -r client/* "${BASE_DIR}/client/"
sudo chown -R arkfile:arkfile "${BASE_DIR}/client"

# Clean up temporary build directory
rm -rf ${BUILD_DIR}

echo -e "${GREEN}Build complete!${NC}"
echo "Release directory: ${RELEASE_DIR}"
echo "Binary location: ${BASE_DIR}/bin/${APP_NAME}"
echo "Current symlink updated: ${BASE_DIR}/releases/current"
